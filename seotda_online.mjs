import crypto from 'node:crypto';
import {WebSocket} from 'ws';

// 삐약 섯다 전용, 상태는 서버 메모리에만 보관(순위/칩 영구 저장 없음).
const CODE='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms=new Map();
const TURN_MS=45_000, ROOM_TTL=3*60*60*1000;
const now=()=>Date.now();
const safeName=s=>String(s||'').trim().replace(/[<>"'`\\\r\n]/g,'').slice(0,16);
const send=(ws,o)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o));};
const err=(ws,message)=>send(ws,{type:'seotda_error',message});
const randCode=()=>Array.from({length:6},()=>CODE[crypto.randomInt(CODE.length)]).join('');
const timer=(r,ms,fn)=>{clearTimeout(r.timer);let tag=++r.tag;r.timer=setTimeout(()=>{if(r.tag===tag&&rooms.get(r.id)===r)fn();},ms);};
function makeRoom(){let id;do{id=randCode()}while(rooms.has(id));const r={id,players:[],watchers:new Set(),started:false,phase:'lobby',round:0,pot:0,deck:[],turn:-1,pending:[],highest:0,starter:0,nextStarter:0,tiePlayers:[],tieCount:0,lastRaiser:-1,actionCount:0,serial:0,winner:[],elimination:[],ranking:[],deadline:0,timer:null,tag:0,updated:now(),notice:'방장이 2~5명 입장 후 게임을 시작할 수 있습니다.',hostToken:null};rooms.set(id,r);return r;}
const allSockets=r=>[...r.players.map(p=>p.ws).filter(Boolean),...r.watchers];
function playerView(p,i,r,viewer){
  const showdown=['result','finished'].includes(r.phase),tie=['tieannounce','tiebet'].includes(r.phase);
  return {index:i,name:p.name,connected:!!p.ws&&p.ws.readyState===WebSocket.OPEN,host:p.token===r.hostToken,
    chips:p.chips,folded:p.folded,allin:p.allin,eliminated:p.eliminated,winner:r.winner.includes(i),
    tied:tie&&r.tiePlayers.includes(i),stagePaid:p.stagePaid,message:p.message,messageSerial:p.messageSerial,
    hand:(showdown||tie)&&!p.folded?p.hand[1]:'',
    cards:[0,1].map(j=>{
      const c=p.cards[j];if(!c||(!p.firstDealt&&j===0)||(!p.secondDealt&&j===1))return null;
      if(tie||showdown||j===0||viewer===i&&p.secondDealt)return {m:c.m,k:c.k,row:c.row,col:c.col};
      return {hidden:true};
    })};
}
function snapshot(r,viewer=-1){return {type:'seotda_state',room:r.id,phase:r.phase,started:r.started,
  round:r.round,pot:r.pot,turn:r.turn,pending:r.pending,highest:r.highest,starter:r.starter,
  lastRaiser:r.lastRaiser,tiePlayers:r.tiePlayers,tieCount:r.tieCount,deadline:r.deadline,serverNow:now(),
  spectators:r.watchers.size,notice:r.notice,winners:r.winner,ranking:r.ranking,serial:r.serial,
  players:r.players.map((p,i)=>playerView(p,i,r,viewer))};}
function publish(r){r.updated=now();r.players.forEach((p,i)=>send(p.ws,snapshot(r,i)));r.watchers.forEach(ws=>send(ws,snapshot(r,-1)));}
function announce(r,text){r.notice=text;publish(r);}
const deckSpec=()=>{let a=[];for(let row=0;row<4;row++)for(let col=0;col<5;col++){let m=(row%2)*5+col+1;let k=(row>=2?1:0);let bright=row<2&&(m===1||m===3||m===8);a.push({m,k,row,col,bright});}return a;};
function shuffle(){const a=deckSpec();for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function handRank(cs){if(cs.length<2)return [0,''];let a=cs[0],b=cs[1],lo=Math.min(a.m,b.m),hi=Math.max(a.m,b.m),g=a.bright&&b.bright;
 if(g&&lo===3&&hi===8)return [1000,'38광땡'];
 if(g&&lo===1&&(hi===3||hi===8))return [900,`1${hi}광땡`];
 if(a.m===b.m)return [600+a.m,a.m===10?'장땡':`${a.m}땡`];
 const has=(m1,m2)=>lo===m1&&hi===m2;
 if(has(4,9)){const special=a.k===1&&b.k===1;return [(a.m+b.m)%10,special?'멍구사':'사구'];}
 if(has(4,7)&&a.k===1&&b.k===1)return [1,'암행어사'];
 for(const [x,y,v,n] of [[1,2,520,'알리'],[1,4,510,'독사'],[1,9,500,'구삥'],[1,10,490,'장삥'],[4,10,480,'장사'],[4,6,470,'세륙']])if(has(x,y))return [v,n];
 const n=(a.m+b.m)%10;return [n,n===9?'갑오':n===0?'망통':`${n}끗`];
}
function showdown(r,indices){
 if(indices.length===1)return {winners:indices};
 const best=Math.max(...indices.map(i=>r.players[i].hand[0]));
 const assassins=indices.filter(i=>r.players[i].hand[1]==='암행어사');
 if(best===900&&assassins.length)return {winners:assassins,reason:'암행어사가 광땡을 잡았습니다!'};
 for(const kind of ['멍구사','사구'])for(const i of indices){if(r.players[i].hand[1]!==kind)continue;
  const other=indices.filter(x=>x!==i),v=Math.max(...other.map(x=>r.players[x].hand[0]));
  if(v<=(kind==='멍구사'?609:520))return {rematch:true,winners:indices,reason:`${kind} 발동! 생존자 전원 재승부`};
 }
 const winners=indices.filter(i=>r.players[i].hand[0]===best);
 return winners.length>1?{rematch:true,winners,reason:'같은 족보 무승부'}:{winners};
}
function actors(r){const pool=r.phase==='tiebet'?r.tiePlayers:r.players.map((_,i)=>i);return pool.filter(i=>{const p=r.players[i];return !p.eliminated&&!p.folded;});}
const canAct=(r,i)=>{let p=r.players[i];return p&&!p.folded&&!p.eliminated&&!p.allin;};
const due=(r,i)=>Math.max(0,r.highest-r.players[i].stagePaid);
function rotate(indices,start){const k=indices.indexOf(start);return k<0?indices:indices.slice(k).concat(indices.slice(0,k));}
function stage(r,phase,start){r.phase=phase;r.actionCount=0;r.highest=0;r.lastRaiser=-1;
 r.players.forEach(p=>{p.stagePaid=0;p.message='';p.messageSerial=0;});
 r.pending=rotate(actors(r).filter(i=>canAct(r,i)),start);r.turn=r.pending[0]??-1;
 if(r.turn<0){finishStage(r);return;}
 r.deadline=now()+TURN_MS;publish(r);watchTurn(r);
}
function watchTurn(r){if(r.turn<0)return;timer(r,TURN_MS+150,()=>{
  const i=r.turn;if(i<0)return;
  // 연결이 끊긴 선수 또는 시간초과 선수는 현재 판에서 다이 처리
  apply(r,i,'fold',true);
});}
function roundStart(r){const survive=r.players.map((p,i)=>!p.eliminated?i:null).filter(x=>x!==null);
 if(survive.length<2){finishMatch(r);return;}
 r.round++;r.phase='deal1';r.deck=shuffle();r.pot=0;r.tiePlayers=[];r.tieCount=0;r.winner=[];
 r.players.forEach(p=>{p.cards=[];p.firstDealt=false;p.secondDealt=false;p.folded=p.eliminated;p.allin=false;p.message='';p.messageSerial=0;p.stagePaid=0;p.totalPaid=0;p.hand=[0,''];if(p.eliminated)return;
   p.cards=[r.deck.pop(),null];let ante=Math.min(20,p.chips);p.chips-=ante;p.totalPaid+=ante;r.pot+=ante;});
 r.starter=survive.includes(r.nextStarter)?r.nextStarter:survive[0];
 announce(r,`ROUND ${r.round}: 중앙에서 첫 번째 화투패를 배분합니다.`);
 timer(r,1550,()=>{r.players.forEach(p=>{if(!p.eliminated)p.firstDealt=true;});stage(r,'bet1',r.starter);});
}
function finishStage(r){r.pending=[];r.turn=-1;r.deadline=0;
 const remain=actors(r);
 if(remain.length<=1){award(r,remain.length?remain:[r.players.findIndex(p=>!p.eliminated)]);return;}
 if(r.phase==='bet1'){
  r.nextStageStarter=r.lastRaiser>=0?r.lastRaiser:r.starter;r.phase='deal2';
  const d=r.deck;r.players.forEach(p=>{if(p.eliminated||p.folded)return;p.cards[1]=d.pop();p.secondDealt=false;p.hand=handRank(p.cards);});
  announce(r,'1차 베팅 완료 · 두 번째 패 배분 중입니다.');
  timer(r,1550,()=>{r.players.forEach(p=>{if(p.cards[1])p.secondDealt=true;});stage(r,'bet2',r.nextStageStarter);});return;
 }
 if(r.phase==='bet2'||r.phase==='tiebet'){
  r.phase='showdown';publish(r);
  timer(r,5000,()=>resolve(r));
 }
}
function resolve(r){const result=showdown(r,actors(r));
 if(result.rematch){r.tiePlayers=result.winners;r.tieCount++;r.phase='tieannounce';r.turn=-1;announce(r,result.reason+' · 해당 선수에게 새 패가 배분됩니다.');
  timer(r,1800,()=>{r.phase='tiedeal';const d=shuffle();for(const i of r.tiePlayers){const p=r.players[i];p.cards=[d.pop(),d.pop()];p.hand=handRank(p.cards);p.firstDealt=true;p.secondDealt=true;}
    publish(r);timer(r,Math.max(1100,r.tiePlayers.length*2*160+600),()=>stage(r,'tiebet',r.tiePlayers[0]));});
 }else award(r,result.winners,result.reason);
}
function award(r,winners,reason=''){
 r.phase='result';r.turn=-1;r.deadline=0;r.pending=[];r.winner=winners;
 // 사이드팟: 올인한 선수가 넣지 않은 칩은 가져갈 수 없습니다.
 const tiers=[...new Set(r.players.map(p=>p.totalPaid).filter(v=>v>0))].sort((a,b)=>a-b);
 let last=0;
 for(const tier of tiers){
   const participating=r.players.map((p,i)=>p.totalPaid>=tier?i:-1).filter(i=>i>=0);
   const amount=(tier-last)*participating.length;
   let elig=winners.filter(i=>r.players[i].totalPaid>=tier);
   if(!elig.length){
     // 판돈 일부를 받을 자격이 없는 메인 승자는 이 구간을 가져가지 않음.
     // 자격이 있는 비다이 참가자들의 족보를 기준으로 지급한다.
     const remain=participating.filter(i=>!r.players[i].folded&&!r.players[i].eliminated);
     if(remain.length){const top=Math.max(...remain.map(i=>r.players[i].hand[0]));elig=remain.filter(i=>r.players[i].hand[0]===top);}
     else elig=participating.slice(0,1);
   }
   const share=Math.floor(amount/elig.length);for(const i of elig)r.players[i].chips+=share;
   r.players[elig[0]].chips+=amount-share*elig.length;
   last=tier;
 }
 r.nextStarter=winners[0];
 const dropped=[];
 for(let i=0;i<r.players.length;i++){let p=r.players[i];if(!p.eliminated&&p.chips<=0){p.chips=0;p.eliminated=true;dropped.push(i);}}
 if(dropped.length)r.elimination.push(dropped);
 announce(r,`${reason?reason+' · ':''}${winners.map(i=>r.players[i].name).join(', ')} WINNER! · ${r.pot.toLocaleString()}칩`);
 if(r.players.filter(p=>!p.eliminated).length<2){finishMatch(r);return;}
 timer(r,3000,()=>roundStart(r));
}
function finishMatch(r){r.phase='finished';r.turn=-1;r.pending=[];r.deadline=0;clearTimeout(r.timer);r.tag++;
 const alive=r.players.map((p,i)=>!p.eliminated?i:null).filter(v=>v!==null);
 r.ranking=[];for(const i of alive)r.ranking.push({rank:1,name:r.players[i].name,chips:r.players[i].chips});
 let place=alive.length+1;for(const group of r.elimination.slice().reverse()){for(const i of group)r.ranking.push({rank:place,name:r.players[i].name,chips:0});place+=group.length;}
 announce(r,`최종 우승: ${alive.map(i=>r.players[i].name).join(', ')}! 방장이 전체 재시작을 진행할 수 있습니다.`);
}
function apply(r,i,kind,timeout=false){
 if(r.turn!==i||!['bet1','bet2','tiebet'].includes(r.phase))throw Error('현재 본인 차례가 아닙니다.');
 const p=r.players[i],need=due(r,i),beforePot=r.pot;let pay=0,newHigh=false,label='',kindLabel=kind;
 if(kind==='fold'){p.folded=true;label=timeout?'시간초과 다이':'다이';}
 else if(kind==='call'){pay=Math.min(need,p.chips);label=need?'콜':'체크';}
 else if(kind==='half'){
  const extra=Math.min(Math.floor(beforePot/2),Math.max(0,p.chips-need),Math.max(0,beforePot-need));
  if(extra<=0||p.chips<need+extra)throw Error('하프를 할 수 없습니다.');
  pay=need+extra;label='하프';newHigh=true;
 }else if(kind==='allin'){pay=p.chips;if(pay<=0)throw Error('올인할 칩이 없습니다.');label='올인';newHigh=p.stagePaid+pay>r.highest;}
 else throw Error('선택할 수 없는 행동입니다.');
 if(kind!=='fold'){pay=Math.min(pay,p.chips);p.chips-=pay;p.stagePaid+=pay;p.totalPaid+=pay;r.pot+=pay;if(p.chips===0)p.allin=true;if(p.stagePaid>r.highest){r.highest=p.stagePaid;newHigh=true;}}
 p.message=label+'!';p.messageSerial=++r.serial;r.actionCount++;r.pending.shift();
 if(newHigh){r.lastRaiser=i;const others=actors(r).filter(j=>j!==i&&canAct(r,j));r.pending=[];for(let step=1;step<=r.players.length;step++){const j=(i+step)%r.players.length;if(others.includes(j))r.pending.push(j);}}
 else r.pending=r.pending.filter(j=>canAct(r,j));
 if(actors(r).length<2||!r.pending.length){finishStage(r);return;}
 r.turn=r.pending[0];r.deadline=now()+TURN_MS;publish(r);watchTurn(r);
}
function resetAll(r){r.started=true;r.round=0;r.phase='lobby';r.elimination=[];r.ranking=[];r.nextStarter=0;r.winner=[];r.players.forEach(p=>{p.chips=1000;p.eliminated=false;p.folded=false;p.allin=false;p.hand=[0,''];p.cards=[];p.message='';p.stagePaid=0;p.totalPaid=0;});roundStart(r);}
function sendJoin(ws,r,role,index,token){ws.seotda={room:r.id,role,index};send(ws,{type:'seotda_joined',room:r.id,role,index,token});publish(r);}
function detach(ws,notify=true){const meta=ws.seotda;if(!meta)return;ws.seotda=null;const r=rooms.get(meta.room);if(!r)return;
 if(meta.role==='spectator')r.watchers.delete(ws);
 else {const p=r.players[meta.index];if(p&&p.ws===ws){p.ws=null;if(!r.started){r.players.splice(meta.index,1);r.players.forEach((x,i)=>{if(x.ws?.seotda)x.ws.seotda.index=i;});if(r.players.length&&r.hostToken===p.token)r.hostToken=r.players[0].token;if(r.players.length===0&&r.watchers.size===0){clearTimeout(r.timer);rooms.delete(r.id);return;}}}}
 if(notify)publish(r);
}
export function isSeotdaMessage(_ws,d){return typeof d?.type==='string'&&d.type.startsWith('seotda_');}
export function detachSeotda(ws){detach(ws);}
export function handleSeotdaMessage(ws,d){try{
 if(d.type==='seotda_create'){
  if(d.agree!==true)throw Error('클럽원 이용 약속을 확인해 주세요.');const name=safeName(d.name);if(!name)throw Error('닉네임을 입력해 주세요.');
  detach(ws);const r=makeRoom(),token=crypto.randomBytes(24).toString('hex');const p={name,token,ws,chips:1000,eliminated:false,folded:false,allin:false,hand:[0,''],cards:[],firstDealt:false,secondDealt:false,stagePaid:0,totalPaid:0,message:'',messageSerial:0};r.hostToken=token;r.players.push(p);sendJoin(ws,r,'player',0,token);return;
 }
 if(d.type==='seotda_join'){
  if(d.agree!==true)throw Error('클럽원 이용 약속을 확인해 주세요.');const id=String(d.room||'').trim().toUpperCase();const r=rooms.get(id);if(!r)throw Error('해당 방을 찾을 수 없습니다.');
  detach(ws);const token=String(d.token||'');const existing=r.players.findIndex(p=>p.token===token&&token);
  if(existing>=0){const p=r.players[existing];if(p.ws&&p.ws!==ws){send(p.ws,{type:'seotda_notice',message:'같은 계정으로 재접속되었습니다.'});p.ws.seotda=null;p.ws.close();}p.ws=ws;sendJoin(ws,r,'player',existing,p.token);return;}
  if(d.spectator||r.started||r.players.length>=5){r.watchers.add(ws);sendJoin(ws,r,'spectator',-1,null);return;}
  const name=safeName(d.name)||`선수${r.players.length+1}`;if(r.players.some(p=>p.name===name))throw Error('이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.');
  const key=crypto.randomBytes(24).toString('hex');r.players.push({name,token:key,ws,chips:1000,eliminated:false,folded:false,allin:false,hand:[0,''],cards:[],firstDealt:false,secondDealt:false,stagePaid:0,totalPaid:0,message:'',messageSerial:0});sendJoin(ws,r,'player',r.players.length-1,key);return;
 }
 if(d.type==='seotda_leave'){detach(ws);send(ws,{type:'seotda_left'});return;}
 const meta=ws.seotda;if(!meta)throw Error('먼저 온라인 방에 입장하세요.');const r=rooms.get(meta.room);if(!r)throw Error('방이 종료되었습니다.');
 if(d.type==='seotda_chat'){const m=String(d.message||'').trim().slice(0,120).replace(/[<>]/g,'');if(!m)return;const name=meta.role==='player'?r.players[meta.index].name:'관전자';for(const peer of allSockets(r))send(peer,{type:'seotda_chat',name,message:m});return;}
 if(meta.role!=='player')throw Error('관전자는 행동할 수 없습니다.');const p=r.players[meta.index];if(p.ws!==ws)throw Error('이 세션은 유효하지 않습니다.');
 if(d.type==='seotda_start'){if(p.token!==r.hostToken)throw Error('방장만 게임을 시작할 수 있습니다.');if(r.started)throw Error('게임이 이미 진행 중입니다.');if(r.players.length<2)throw Error('최소 2명이 필요합니다.');if(r.players.some(x=>x.ws?.readyState!==WebSocket.OPEN))throw Error('모든 참가자가 연결되어 있어야 시작할 수 있습니다.');resetAll(r);return;}
 if(d.type==='seotda_restart'){if(p.token!==r.hostToken)throw Error('방장만 전체 재시작할 수 있습니다.');if(r.phase!=='finished')throw Error('최종 우승 후에만 전체 재시작할 수 있습니다.');resetAll(r);return;}
 if(d.type==='seotda_action'){apply(r,meta.index,d.action);return;}
 throw Error('알 수 없는 요청입니다.');
 }catch(e){err(ws,e.message||'처리 중 오류');}}
export function getSeotdaRoomCount(){return rooms.size;}
export function cleanSeotdaRooms(){for(const [id,r] of rooms){const live=allSockets(r).some(ws=>ws.readyState===WebSocket.OPEN);if(!live&&now()-r.updated>ROOM_TTL){clearTimeout(r.timer);rooms.delete(id);}}}

