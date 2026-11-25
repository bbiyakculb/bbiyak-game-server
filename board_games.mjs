import crypto from 'node:crypto';
import {WebSocket} from 'ws';
import * as chess from './chess_rules.mjs';
import * as janggi from './janggi_rules.mjs';
const engines={chess,janggi};
const rooms=new Map();const TTL=3*60*60*1000,TURN=60000,SETUP_MS=20000;const SETUP_OPTIONS=new Set(['heeh','hehe','eheh','ehhe']);
const send=(ws,data)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));};
const name=(s,fallback)=>String(s||'').trim().replace(/[<>"'`\\]/g,'').slice(0,16)||fallback;
const online=r=>r.players.every(p=>p?.ws?.readyState===WebSocket.OPEN);
// Chess engine uses 1 (white) and -1 (black); room seats use 1 and 2.
const turnSeat=r=>r.game==='chess'?(r.state.t===1?1:2):r.state.t;
const peers=r=>[...r.players.map(p=>p?.ws).filter(Boolean),...r.spectators];
const resetJanggiSetup=r=>{if(r.game==='janggi')r.setup={phase:'waiting',endsAt:null,choices:{1:'ehhe',2:'ehhe'},done:{1:false,2:false}};};
function manageJanggiSetup(r){if(r.game!=='janggi'||!r.setup||r.moves.length||r.winner||r.draw)return;
 const setup=r.setup;
 if(setup.phase==='ready')return;
 if(!online(r)){if(setup.phase!=='waiting'){setup.phase='waiting';setup.endsAt=null;setup.done={1:false,2:false};publish(r);}return;}
 if(setup.phase==='waiting'){setup.phase='choosing';setup.endsAt=Date.now()+SETUP_MS;publish(r);return;}
 if(setup.phase==='choosing'&&(Date.now()>=setup.endsAt||(setup.done[1]&&setup.done[2]))){
   r.state=janggi.init(setup.choices);r.history=[r.state];r.moves=[];setup.phase='ready';setup.endsAt=null;
   startClock(r);notice(r,'마·상 배치가 확정되었습니다. 대국을 시작합니다.');publish(r);
 }
}

const publish=r=>{r.updated=Date.now();const e=engines[r.game];const obj={type:'board_state',game:r.game,room:r.id,...e.snapshot(r.game==='janggi'&&r.setup?.phase==='choosing'?janggi.init(r.setup.choices):r.state),moves:r.moves,round:r.round,score:r.score,winner:r.winner,draw:r.draw,reason:r.reason,deadline:r.deadline,serverNow:Date.now(),players:r.players.map(p=>p?{name:p.name,online:p.ws?.readyState===WebSocket.OPEN}:null),spectators:r.spectators.size,pendingUndo:r.undo,rematchCount:r.rematch.size,setup:r.game==='janggi'?r.setup:null};for(const ws of peers(r))send(ws,obj);};
const notice=(r,msg)=>{for(const ws of peers(r))send(ws,{type:'notice',message:msg});};
const startClock=r=>{r.deadline=!r.winner&&!r.draw&&!r.undo&&online(r)&&(r.game!=='janggi'||r.setup?.phase==='ready')?Date.now()+TURN:null;};
function expire(r){if(!r.deadline||r.winner||r.draw||Date.now()<r.deadline)return;if(!online(r)){r.deadline=null;return;}r.winner=3-turnSeat(r);r.reason='한 수 60초 시간 초과';r.score[r.winner-1]++;r.deadline=null;notice(r,r.reason+' · 상대 승리');publish(r);}
function detach(ws){const meta=ws.boardMeta;if(!meta)return;ws.boardMeta=null;const r=rooms.get(meta.room);if(!r)return;if(meta.role==='spectator')r.spectators.delete(ws);else if(r.players[meta.role-1]?.ws===ws)r.players[meta.role-1].ws=null;r.undo=null;r.rematch.clear();startClock(r);publish(r);}
export function detachBoard(ws){detach(ws);}
const token=()=>crypto.randomBytes(24).toString('hex');
function join(ws,r,data,creator){detach(ws);let role='spectator',stored=null;const t=String(data.token||'');if(t){const k=r.players.findIndex(p=>p?.token===t);if(k>=0){role=k+1;const other=r.players[k].ws;if(other&&other!==ws){other.boardMeta=null;other.close();}r.players[k].ws=ws;}}
if(role==='spectator'&&!data.spectator){const k=creator?(data.color===2?1:0):r.players.findIndex(p=>!p);if(k>=0&&!r.players[k]){role=k+1;stored=token();r.players[k]={name:name(data.name,creator?'선수1':'선수2'),token:stored,ws};}}
if(role==='spectator')r.spectators.add(ws);
ws.boardMeta={room:r.id,role,name:name(data.name,role==='spectator'?'관전자':r.players[role-1].name)};
manageJanggiSetup(r);startClock(r);send(ws,{type:'board_joined',game:r.game,room:r.id,role,token:stored||(typeof role==='number'?r.players[role-1].token:null)});publish(r);}
export function isBoardMessage(ws,d){return !!ws.boardMeta||((d.type==='create'||d.type==='join')&&!!engines[d.game]);}
export function handleBoardMessage(ws,d){try{if(d.type==='create'){const game=d.game,e=engines[game];if(!e)throw Error('게임 종류 오류');let id;do{id=Array.from({length:6},()=>('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')[crypto.randomInt(32)]).join('');}while(rooms.has(id));const r={id,game,state:e.init(),history:[],moves:[],players:[null,null],spectators:new Set(),score:[0,0],winner:0,draw:false,reason:'',round:1,deadline:null,undo:null,rematch:new Map(),updated:Date.now()};r.history=[r.state];resetJanggiSetup(r);rooms.set(id,r);join(ws,r,d,true);return;}
if(d.type==='join'){const r=rooms.get(String(d.room||'').trim().toUpperCase());if(!r||r.game!==d.game)throw Error('방이 없거나 게임 종류가 다릅니다.');join(ws,r,d,false);return;}
if(d.type==='leave'){detach(ws);send(ws,{type:'board_left'});return;}
const meta=ws.boardMeta;if(!meta)throw Error('방에 먼저 입장하세요.');const r=rooms.get(meta.room);if(!r)throw Error('방이 종료되었습니다.');const seat=meta.role;
if(d.type==='rename'){meta.name=name(d.name,seat==='spectator'?'관전자':seat===1?'선수1':'선수2');if(typeof seat==='number')r.players[seat-1].name=meta.name;publish(r);return;}
if(d.type==='janggi_setup'&&r.game==='janggi'){
 if(typeof seat!=='number')throw Error('관전자는 배치를 선택할 수 없습니다.');
 if(!SETUP_OPTIONS.has(d.layout))throw Error('올바른 마·상 배치를 선택해 주세요.');
 if(r.setup?.phase!=='choosing'||Date.now()>=r.setup.endsAt)throw Error('마·상 배치 선택 시간이 종료되었습니다.');
 if(r.setup.done[seat])throw Error('이미 배치를 확정했습니다.');
 r.setup.choices[seat]=d.layout;
 if(d.confirm===true)r.setup.done[seat]=true;
 manageJanggiSetup(r);publish(r);return;
}
if(d.type==='chat'){const msg=String(d.message||'').trim().slice(0,120);if(msg)for(const peer of peers(r))send(peer,{type:'board_chat',name:typeof seat==='number'?r.players[seat-1].name:meta.name,message:msg});return;}
if(typeof seat!=='number')throw Error('관전자는 착수할 수 없습니다.');
if(r.game==='janggi'&&r.setup?.phase!=='ready'&&['move','pass','undo_request'].includes(d.type))throw Error('마·상 배치 선택이 끝난 뒤 착수할 수 있습니다.');
if(d.type==='pass'&&r.game==='janggi'){if(r.winner||r.draw)throw Error('대국이 종료되었습니다.');if(!online(r))throw Error('상대방 입장을 기다려주세요.');expire(r);if(r.winner)throw Error('시간 초과로 종료되었습니다.');if(turnSeat(r)!==seat)throw Error('상대방 차례입니다.');r.state=janggi.pass(r.state);r.history.push(r.state);r.moves.push('한 수 쉼');r.undo=null;const st=janggi.status(r.state,r.history);r.winner=st.winner;r.draw=st.draw;r.reason=st.reason;if(r.winner)r.score[r.winner-1]++;startClock(r);publish(r);return;}
if(d.type==='move'){if(r.winner||r.draw)throw Error('대국이 종료되었습니다.');if(!online(r))throw Error('상대방 입장을 기다려주세요.');expire(r);if(r.winner)throw Error('시간 초과로 종료되었습니다.');if(turnSeat(r)!==seat)throw Error('상대방 차례입니다.');const result=engines[r.game].move(r.state,d);r.state=result.state;r.history.push(result.state);r.moves.push(result.label);r.undo=null;r.rematch.clear();const status=engines[r.game].status(r.state,r.history);r.winner=status.winner;r.draw=status.draw;r.reason=status.reason;if(r.winner)r.score[r.winner-1]++;startClock(r);publish(r);return;}
if(d.type==='undo_request'){if(!r.moves.length||r.winner||r.draw||r.undo)throw Error('지금 무르기를 요청할 수 없습니다.');r.undo=seat;r.deadline=null;publish(r);return;}
if(d.type==='undo_answer'){if(r.undo!==3-seat)throw Error('답변할 무르기 요청이 없습니다.');if(d.accept===true){r.history.pop();r.moves.pop();r.state=r.history.at(-1);}r.undo=null;startClock(r);publish(r);return;}
if(d.type==='rematch'){if(!r.winner&&!r.draw)throw Error('대국 종료 후 재대결할 수 있습니다.');if(!online(r))throw Error('상대방 접속을 기다려주세요.');const color=d.color===2?2:d.color===1?1:0;if(!color)throw Error('선공 또는 후공을 선택하세요.');if(r.rematch.get(3-seat)===color)throw Error('상대방과 다른 색을 선택하세요.');r.rematch.set(seat,color);if(r.rematch.size===2){const old=r.players.slice(),scores=r.score.slice();if(r.rematch.get(1)===2){r.players=[old[1],old[0]];r.score=[scores[1],scores[0]];for(let i=0;i<2;i++)if(r.players[i]?.ws){const p=r.players[i];p.ws.boardMeta.role=i+1;send(p.ws,{type:'board_joined',game:r.game,room:r.id,role:i+1,token:p.token});}}r.state=engines[r.game].init();resetJanggiSetup(r);r.history=[r.state];r.moves=[];r.winner=0;r.draw=false;r.reason='';r.round++;r.undo=null;r.rematch.clear();startClock(r);if(r.game==='janggi'){manageJanggiSetup(r);notice(r,'재대결: 마·상 배치를 20초 안에 선택해 주세요. 두 선수 모두 선택 완료하면 바로 시작합니다.');}else notice(r,'재대결이 시작되었습니다. 선공부터 두세요.');}publish(r);return;}
}catch(e){send(ws,{type:'error',message:e.message||'처리 실패'});}}
export function tickBoard(){for(const [id,r] of rooms){manageJanggiSetup(r);expire(r);if(!peers(r).some(ws=>ws.readyState===WebSocket.OPEN)&&Date.now()-r.updated>TTL)rooms.delete(id);}}
