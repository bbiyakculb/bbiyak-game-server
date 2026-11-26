// 삐약 알까기 온라인: 기존 오목·장기·체스와 독립된 방 및 물리 엔진
import crypto from 'node:crypto';
import {WebSocket} from 'ws';
const rooms=new Map(), CHARSET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL=3*60*60*1000, FRAME_MS=1000/60, TURN_MS=60000;
const TYPES={king:{r:49.5,m:30},rook:{r:44.5,m:20},horse:{r:44.5,m:20},elephant:{r:44.5,m:20},guard:{r:36,m:20},cannon:{r:44.5,m:20},soldier:{r:36,m:10}};
const OUT={l:0,r:900,t:0,b:1000};
const send=(ws,data)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));};
const cleanName=(v,def='선수')=>String(v||'').trim().replace(/[<>"'`\\\r\n]/g,'').slice(0,16)||def;
const peers=r=>[...r.players.map(p=>p?.ws).filter(Boolean),...r.spectators];
const online=r=>r.players.every(p=>p?.ws?.readyState===WebSocket.OPEN);
const code=()=>Array.from({length:6},()=>CHARSET[crypto.randomInt(CHARSET.length)]).join('');
function piecesInit(){const a=[];let id=0;for(const [team,back,king,cannon,soldier] of [['blue',0,1,2,3],['red',9,8,7,6]]){
 const row=[['rook',0],['elephant',1],['horse',2],['guard',3],['guard',5],['horse',6],['elephant',7],['rook',8]];
 const add=(type,col,r)=>{const t=TYPES[type];a.push({id:String(id++),team,type,x:50+100*col,y:50+100*r,vx:0,vy:0,r:t.r,m:t.m,alive:true,chain:0});};
 row.forEach(([t,c])=>add(t,c,back));add('king',4,king);[1,7].forEach(c=>add('cannon',c,cannon));[0,2,4,6,8].forEach(c=>add('soldier',c,soldier));
}return a;}
const alive=r=>({red:r.pieces.filter(p=>p.alive&&p.team==='red').length,blue:r.pieces.filter(p=>p.alive&&p.team==='blue').length});
function state(r,includePhysics=true){return {type:'alk_state',room:r.id,turn:r.turn,rolling:r.rolling,winner:r.winner,round:r.round,score:r.score,players:r.players.map(p=>p?{name:p.name,online:p.ws?.readyState===WebSocket.OPEN}:null),spectators:r.spectators.size,pieces:r.pieces.map(p=>({id:p.id,team:p.team,type:p.type,x:+p.x.toFixed(3),y:+p.y.toFixed(3),alive:p.alive,...(includePhysics?{vx:+p.vx.toFixed(3),vy:+p.vy.toFixed(3)}:{})})),deadline:r.deadline,serverNow:Date.now(),shots:r.shots,undoSeat:r.undoSeat,rematchCount:r.rematch.size};}
function publish(r){r.updated=Date.now();const d=state(r);for(const w of peers(r))send(w,d);}
function notice(r,msg){for(const w of peers(r))send(w,{type:'notice',message:msg});}
function clock(r){r.deadline=!r.winner&&!r.rolling&&!r.undoSeat&&online(r)?Date.now()+TURN_MS:null;}
function settle(r){r.rolling=false;clearInterval(r.timer);r.timer=null;for(const p of r.pieces){p.vx=0;p.vy=0;}const count=alive(r);
 if(count.red===0||count.blue===0){r.winner=count.red===0?2:1;r.score[r.winner-1]++;r.deadline=null;notice(r,(r.winner===1?'한':'초')+' 진영 승리!');}
 else{r.turn=3-r.turn;clock(r);}publish(r);
}
function physicsTick(r){const dt=1.4,substeps=3,step=dt/substeps;let collided=false,fallen=false;
 for(let sub=0;sub<substeps;sub++){
 const active=r.pieces.filter(p=>p.alive);
 for(const p of active){p.x+=p.vx*step;p.y+=p.vy*step;const friction=Math.pow(.980,step);p.vx*=friction;p.vy*=friction;if(Math.hypot(p.vx,p.vy)<.08){p.vx=0;p.vy=0;}if(p.x<OUT.l-p.r||p.x>OUT.r+p.r||p.y<OUT.t-p.r||p.y>OUT.b+p.r){p.alive=false;p.vx=p.vy=0;fallen=true;}}
 const a=r.pieces.filter(p=>p.alive);
 for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){
 const p=a[i],q=a[j],dx=q.x-p.x,dy=q.y-p.y,d=Math.hypot(dx,dy)||.0001,min=p.r+q.r;
 if(d>=min)continue;
 const nx=dx/d,ny=dy/d,invP=1/p.m,invQ=1/q.m,inv=invP+invQ,overlap=min-d+.04;
 p.x-=nx*overlap*invP/inv;p.y-=ny*overlap*invP/inv;q.x+=nx*overlap*invQ/inv;q.y+=ny*overlap*invQ/inv;
 const rel=(q.vx-p.vx)*nx+(q.vy-p.vy)*ny;
 if(rel<0){if(rel<-1.5)collided=true;const pa=p.vx*nx+p.vy*ny,qa=-(q.vx*nx+q.vy*ny),mover=pa>=qa?p:q,secondary=mover.chain>=1;
 const impulse=-(1+(secondary?.48:.87))*rel/inv*(secondary?.62:1);
 p.vx-=impulse*invP*nx;p.vy-=impulse*invP*ny;q.vx+=impulse*invQ*nx;q.vy+=impulse*invQ*ny;
 if(mover===p)q.chain=Math.max(q.chain,p.chain+1);else p.chain=Math.max(p.chain,q.chain+1);
 }
 }
 }
 r.simSteps++;if(collided&&r.simSteps-r.lastHitStep>7){r.lastHitStep=r.simSteps;for(const w of peers(r))send(w,{type:'alk_sfx',kind:'hit'});}if(fallen)for(const w of peers(r))send(w,{type:'alk_sfx',kind:'fall'});
 if(r.simSteps%2===0)publish(r);
 const moving=r.pieces.some(p=>p.alive&&Math.hypot(p.vx,p.vy)>.18);
 if(!moving)r.stillSteps++;else r.stillSteps=0;
 if(r.stillSteps>12||r.simSteps>650)settle(r);
}
function stop(r){if(r.timer)clearInterval(r.timer);r.timer=null;r.rolling=false;}
function detach(ws){const m=ws.alkMeta;if(!m)return;ws.alkMeta=null;const r=rooms.get(m.room);if(!r)return;if(m.role==='spectator')r.spectators.delete(ws);else if(r.players[m.role-1]?.ws===ws)r.players[m.role-1].ws=null;r.undoSeat=null;r.rematch.clear();if(!r.rolling)clock(r);publish(r);}
export function detachAlkkagi(ws){detach(ws);}
function join(ws,r,data,creator){detach(ws);let role='spectator',newToken=null;const t=String(data.token||'');if(t){const k=r.players.findIndex(p=>p?.token===t);if(k!==-1){role=k+1;const old=r.players[k].ws;if(old&&old!==ws){old.alkMeta=null;old.close();}r.players[k].ws=ws;}}
 if(role==='spectator'&&!data.spectator){const k=creator?(data.color===2?1:0):r.players.findIndex(p=>!p);if(k!==-1&&!r.players[k]){role=k+1;newToken=crypto.randomBytes(24).toString('hex');r.players[k]={name:cleanName(data.name,creator?'선수1':'선수2'),token:newToken,ws};}}
 if(role==='spectator')r.spectators.add(ws);
 ws.alkMeta={room:r.id,role,name:cleanName(data.name,role==='spectator'?'관전자':'선수')};if(!r.rolling)clock(r);send(ws,{type:'alk_joined',room:r.id,role,token:newToken||(typeof role==='number'?r.players[role-1].token:null)});publish(r);
}
export function isAlkkagiMessage(ws,d){return !!ws.alkMeta||((d.type==='create'||d.type==='join')&&d.game==='alkkagi');}
export function handleAlkkagiMessage(ws,d){try{
 if(d.type==='create'){if(d.game!=='alkkagi')throw Error('게임 종류가 다릅니다.');if(!String(d.name||'').trim())throw Error('방을 만들려면 닉네임이 필요합니다.');let id;do{id=code()}while(rooms.has(id));const r={id,players:[null,null],spectators:new Set(),pieces:piecesInit(),turn:1,rolling:false,winner:0,round:1,score:[0,0],shots:0,history:[],undoSeat:null,rematch:new Map(),deadline:null,updated:Date.now(),timer:null,simSteps:0,lastHitStep:0,stillSteps:0};rooms.set(id,r);join(ws,r,d,true);return;}
 if(d.type==='join'){const r=rooms.get(String(d.room||'').trim().toUpperCase());if(!r)throw Error('방이 없거나 종료되었습니다.');join(ws,r,d,false);return;}
 if(d.type==='leave'){detach(ws);send(ws,{type:'alk_left'});return;}
 const m=ws.alkMeta;if(!m)throw Error('먼저 방에 입장하세요.');const r=rooms.get(m.room);if(!r)throw Error('방이 종료되었습니다.');const seat=m.role;
 if(d.type==='rename'){m.name=cleanName(d.name,seat==='spectator'?'관전자':'선수');if(typeof seat==='number')r.players[seat-1].name=m.name;publish(r);return;}
 if(d.type==='chat'){const msg=String(d.message||'').trim().slice(0,120);if(msg)for(const w of peers(r))send(w,{type:'alk_chat',name:typeof seat==='number'?r.players[seat-1].name:m.name,message:msg});return;}
 if(typeof seat!=='number')throw Error('관전자는 발사할 수 없습니다.');
 if(d.type==='shot'){
 if(!online(r))throw Error('상대방이 입장해야 발사할 수 있습니다.');if(r.winner||r.rolling)throw Error('지금은 발사할 수 없습니다.');if(r.undoSeat)throw Error('무르기 요청 처리 중입니다.');if(r.turn!==seat)throw Error('상대방 차례입니다.');
 const p=r.pieces.find(p=>p.id===String(d.pieceId));if(!p?.alive||p.team!==(seat===1?'red':'blue'))throw Error('선택한 장기말로 발사할 수 없습니다.');
 const dx=Number(d.dx),dy=Number(d.dy),power=Number(d.power);
 if(![dx,dy,power].every(Number.isFinite)||Math.abs(Math.hypot(dx,dy)-1)>.03||power<7||power>36)throw Error('발사 값이 올바르지 않습니다.');
 const snapshot=r.pieces.map(p=>({...p}));r.history.push(snapshot);if(r.history.length>4)r.history.shift();
 const base=Math.min(29,5+power*.78),sizePower=p.type==='king'?1.2:(p.type==='soldier'||p.type==='guard')?.9:1.1;
 const speed=base*Math.pow(10/p.m,.08)*.60*sizePower;
 p.chain=0;p.vx=dx*speed;p.vy=dy*speed;r.deadline=null;r.rolling=true;r.shots++;r.simSteps=0;r.stillSteps=0;r.lastHitStep=0;r.undoSeat=null;r.rematch.clear();publish(r);
 for(const w of peers(r))send(w,{type:'alk_sfx',kind:'shot'});
 r.timer=setInterval(()=>{try{physicsTick(r)}catch(e){console.error('alkkagi physics',e);stop(r);publish(r);}},FRAME_MS);return;
 }
 if(d.type==='undo_request'){if(r.rolling||r.winner||!r.history.length||r.undoSeat)throw Error('지금은 무르기를 요청할 수 없습니다.');if(!online(r))throw Error('상대가 입장해야 합니다.');r.undoSeat=seat;r.deadline=null;publish(r);return;}
 if(d.type==='undo_answer'){if(r.undoSeat!==3-seat)throw Error('답변할 무르기 요청이 없습니다.');if(d.accept===true){r.pieces=r.history.pop();r.turn=3-r.turn;r.shots=Math.max(0,r.shots-1);}r.undoSeat=null;clock(r);publish(r);return;}
 if(d.type==='rematch'){if(!r.winner)throw Error('대국 종료 후 재대결할 수 있습니다.');if(!online(r))throw Error('상대방 접속을 기다려주세요.');const color=d.color===2?2:d.color===1?1:null;if(!color)throw Error('진영을 선택하세요.');if(r.rematch.get(3-seat)===color)throw Error('상대방과 다른 진영을 선택하세요.');r.rematch.set(seat,color);
 if(r.rematch.size===2){const old=r.players.slice(),scores=r.score.slice();if(r.rematch.get(1)===2){r.players=[old[1],old[0]];r.score=[scores[1],scores[0]];for(let i=0;i<2;i++){const p=r.players[i];if(p?.ws){p.ws.alkMeta.role=i+1;send(p.ws,{type:'alk_joined',room:r.id,role:i+1,token:p.token});}}}stop(r);r.pieces=piecesInit();r.turn=1;r.winner=0;r.round++;r.history=[];r.undoSeat=null;r.rematch.clear();r.shots=0;clock(r);notice(r,'재대결이 시작되었습니다. 한 진영부터 발사합니다.');}publish(r);return;}
 }catch(e){send(ws,{type:'error',message:e.message||'알까기 처리 오류'});}}
export function tickAlkkagi(){const now=Date.now();for(const [id,r] of rooms){if(r.deadline&&now>=r.deadline&&!r.winner&&!r.rolling&&online(r)){r.winner=3-r.turn;r.score[r.winner-1]++;r.deadline=null;notice(r,'한 수 60초 시간 초과. 상대 승리');publish(r);}if(!peers(r).some(w=>w.readyState===WebSocket.OPEN)&&now-r.updated>TTL){stop(r);rooms.delete(id);}}}
