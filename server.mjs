import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT=Number(process.env.PORT||8000);
const ORIGIN=(process.env.ALLOWED_ORIGIN||'').replace(/\/$/,'');
const rooms=new Map();
const CODE='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLEAN_INTERVAL=60_000, ROOM_TTL=1000*60*60*3;
const safeName=x=>String(x||'').trim().slice(0,16).replace(/[<>"'`\\]/g,'')||'플레이어';
const code=()=>Array.from({length:6},()=>CODE[crypto.randomInt(CODE.length)]).join('');
const send=(ws,obj)=>{if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj));};
const error=(ws,message)=>send(ws,{type:'error',message});
const now=()=>Date.now();
const makeRoom=()=>{let id;do{id=code()}while(rooms.has(id));let r={id,board:Array(225).fill(0),turn:1,moves:[],winner:0,draw:false,players:[null,null],spectators:new Set(),score:[0,0],pendingUndo:null,rematch:new Set(),updated:now(),round:1};rooms.set(id,r);return r;};
const occupied=(r)=>r.players.filter(Boolean).length;
const snapshot=(r)=>({type:'state',room:r.id,board:r.board,turn:r.turn,moves:r.moves,winner:r.winner,draw:r.draw,round:r.round,score:r.score,players:r.players.map(p=>p?{name:p.name,online:!!p.ws&&p.ws.readyState===WebSocket.OPEN}:null),spectators:r.spectators.size,pendingUndo:r.pendingUndo,rematchCount:r.rematch.size});
const sockets=(r)=>[...r.players.map(p=>p?.ws).filter(Boolean),...r.spectators];
const broadcast=(r,obj)=>{r.updated=now();for(const ws of sockets(r))send(ws,obj);};
const publish=r=>broadcast(r,snapshot(r));
const checkWin=(b,index,stone)=>{let x=index%15,y=Math.floor(index/15);for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]){let n=1;for(const sign of [-1,1]){let xx=x+dx*sign,yy=y+dy*sign;while(xx>=0&&xx<15&&yy>=0&&yy<15&&b[yy*15+xx]===stone){n++;xx+=dx*sign;yy+=dy*sign;}}if(n>=5)return true;}return false;};
function detach(ws){const meta=ws.meta;if(!meta)return;let r=rooms.get(meta.room);ws.meta=null;if(!r)return;if(meta.role==='spectator')r.spectators.delete(ws);else{let p=r.players[meta.role-1];if(p?.ws===ws)p.ws=null;}r.pendingUndo=null;r.rematch.clear();publish(r);}
function join(ws,r,name,token,requestedRole){detach(ws);let role='spectator',assignedToken=null;
  if(token){const i=r.players.findIndex(p=>p&&p.token===token);if(i!==-1){role=i+1;const old=r.players[i].ws;if(old&&old!==ws){send(old,{type:'notice',message:'다른 창에서 다시 접속했습니다.'});old.meta=null;old.close();}r.players[i].ws=ws;}}
  if(role==='spectator'&&requestedRole!=='spectator'){const i=r.players.findIndex(p=>!p);if(i!==-1){role=i+1;assignedToken=crypto.randomBytes(24).toString('hex');r.players[i]={name,token:assignedToken,ws};}}
  if(role==='spectator')r.spectators.add(ws);
  ws.meta={room:r.id,role};send(ws,{type:'joined',room:r.id,role,token:assignedToken||((typeof role==='number')?r.players[role-1].token:null)});publish(r);
}
function active(ws){const meta=ws.meta;if(!meta)throw new Error('먼저 방에 입장하세요.');const r=rooms.get(meta.room);if(!r)throw new Error('방이 종료되었습니다.');return {meta,r};}
// GitHub-backed friendly leaderboard. Never expose the token to browsers.
const GH_OWNER=process.env.GITHUB_OWNER||'';
const GH_REPO=process.env.GITHUB_REPO||'';
const GH_BRANCH=process.env.GITHUB_BRANCH||'main';
const GH_TOKEN=process.env.GITHUB_TOKEN||'';
const GH_DIR=(process.env.GITHUB_RECORDS_DIR||'records').replace(/^\/+|\/+$/g,'');
const GH_ENABLED=!!(GH_OWNER&&GH_REPO&&GH_TOKEN);
const games=new Set(['sudoku','mines']);
const tickets=new Map();
const queues={sudoku:Promise.resolve(),mines:Promise.resolve()};
const rate=new Map();
const minute=60_000;
const recordPath=g=>`${GH_DIR}/${g}.json`;
const ghUrl=g=>`https://api.github.com/repos/${encodeURIComponent(GH_OWNER)}/${encodeURIComponent(GH_REPO)}/contents/${recordPath(g).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(GH_BRANCH)}`;
const ghHeaders={'Authorization':`Bearer ${GH_TOKEN}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'bbiyak-minigames-server'};
async function ghCall(url,options={}){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  try{return await fetch(url,{...options,headers:{...ghHeaders,...options.headers},signal:controller.signal});}
  finally{clearTimeout(timer);}
}
function validData(x){return x&&Array.isArray(x.records)?x.records.filter(v=>v&&typeof v.name==='string'&&Number.isFinite(v.seconds)&&v.seconds>0&&v.seconds<=14400).slice(0,1000):[];}
async function readGitHub(game){
  const res=await ghCall(ghUrl(game),{headers:{'Cache-Control':'no-cache'}});
  if(res.status===404)return {sha:null,records:[]};
  if(!res.ok)throw Error(`GitHub 읽기 실패 (${res.status})`);
  const info=await res.json();
  if(info.type!=='file'||typeof info.content!=='string')throw Error('GitHub 기록 파일이 올바르지 않습니다.');
  const contents=Buffer.from(info.content.replace(/\s/g,''),'base64').toString('utf8');
  const data=JSON.parse(contents);
  return {sha:info.sha,records:validData(data)};
}
function ranking(records){return records.slice().sort((a,b)=>a.seconds-b.seconds||a.name.localeCompare(b.name,'ko')).slice(0,100).map((x,i)=>({rank:i+1,name:x.name,seconds:x.seconds,at:x.at}));}
async function writeBest(game,item){
  for(let attempt=0;attempt<5;attempt++){
    const current=await readGitHub(game);
    const records=current.records;
    const previous=records.find(x=>x.name.toLocaleLowerCase('ko')===item.name.toLocaleLowerCase('ko'));
    if(previous&&previous.seconds<=item.seconds)return {updated:false,ranking:ranking(records)};
    const merged=records.filter(x=>x.name.toLocaleLowerCase('ko')!==item.name.toLocaleLowerCase('ko'));
    merged.push(item);
    const payload={message:`records: ${game} ${item.name} ${item.seconds}s`,branch:GH_BRANCH,content:Buffer.from(JSON.stringify({version:1,records:merged},null,2)+'\n').toString('base64')};
    if(current.sha)payload.sha=current.sha;
    const res=await ghCall(ghUrl(game).split('?')[0],{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(res.ok)return {updated:true,ranking:ranking(merged)};
    if(res.status===409||res.status===422){await new Promise(r=>setTimeout(r,100*(attempt+1)));continue;}
    throw Error(`GitHub 저장 실패 (${res.status}). 토큰 권한과 저장소 설정을 확인하세요.`);
  }
  throw Error('동시 기록 등록으로 GitHub 충돌이 반복되었습니다. 다시 시도해 주세요.');
}
function sendJson(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function checkRate(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim().slice(0,80);const current=Date.now();const v=rate.get(ip)||{since:current,n:0};if(current-v.since>minute){v.since=current;v.n=0;}v.n++;rate.set(ip,v);return v.n<=100;}
const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';
  const allowed=!ORIGIN||origin===ORIGIN;
  res.setHeader('Access-Control-Allow-Origin',ORIGIN||'*');res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(allowed?204:403);res.end();return;}
  if(!allowed){sendJson(res,403,{error:'허용되지 않은 출처입니다.'});return;}
  if(!checkRate(req)){sendJson(res,429,{error:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});return;}
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/health'||url.pathname==='/'){sendJson(res,200,{ok:true,service:'bbiyak-minigames',rooms:rooms.size,githubConfigured:GH_ENABLED});return;}
  if(url.pathname==='/api/leaderboard'&&req.method==='GET'){
    const game=url.searchParams.get('game');if(!games.has(game)){sendJson(res,400,{error:'게임 종류가 올바르지 않습니다.'});return;}
    if(!GH_ENABLED){sendJson(res,503,{error:'서버에 GitHub 기록 저장소가 설정되지 않았습니다.'});return;}
    try{const d=await readGitHub(game);sendJson(res,200,{game,ranking:ranking(d.records),total:d.records.length});}
    catch(e){console.error('GitHub leaderboard:',e);sendJson(res,502,{error:e.message});}
    return;
  }
  if(url.pathname.startsWith('/api/')&&req.method==='POST'){
    let raw='';try{
      for await(const part of req){raw+=part;if(raw.length>4096)throw Error('요청이 너무 큽니다.');}
      const d=JSON.parse(raw);const game=d.game;
      if(!games.has(game))throw Error('게임 종류가 올바르지 않습니다.');
      if(!GH_ENABLED){sendJson(res,503,{error:'Koyeb에 GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN을 설정하세요.'});return;}
      if(url.pathname==='/api/start'){
        const ticket=crypto.randomBytes(24).toString('hex');tickets.set(ticket,{game,started:Date.now()});sendJson(res,200,{ticket});return;
      }
      if(url.pathname==='/api/record'){
        const name=String(d.name||'').trim().replace(/[<>"'`\\\r\n]/g,'').slice(0,16);
        const ticket=String(d.ticket||'');const t=tickets.get(ticket);
        if(!name||!t||t.game!==game)throw Error('게임 시작 기록이 없습니다. 새 게임부터 시작하세요.');
        if(t.busy)throw Error('기록 등록 처리 중입니다.');
        const seconds=Math.max(1,Math.floor((Date.now()-t.started)/1000));
        if(seconds>14400)throw Error('4시간을 초과한 기록입니다.');
        if(seconds<2)throw Error('측정 시간이 너무 짧습니다.');
        t.busy=true;
        const job=queues[game].catch(()=>{}).then(()=>writeBest(game,{name,seconds,at:new Date().toISOString()}));
        queues[game]=job.catch(()=>{});
        try{const saved=await job;tickets.delete(ticket);sendJson(res,200,{saved:true,newBest:saved.updated,seconds,ranking:saved.ranking});}
        catch(e){t.busy=false;console.error('GitHub record:',e);sendJson(res,502,{error:e.message});}
        return;
      }
      sendJson(res,404,{error:'없는 경로입니다.'});return;
    }catch(e){sendJson(res,400,{error:e.message||'요청 오류'});return;}
  }
  sendJson(res,404,{error:'없는 경로입니다.'});
});
const wss=new WebSocketServer({server,maxPayload:4096,verifyClient:info=>!ORIGIN||info.origin===ORIGIN||!info.origin});
wss.on('connection',ws=>{ws.isAlive=true;ws.meta=null;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{try{
  let data=JSON.parse(raw.toString());if(!data||typeof data.type!=='string')return;
  if(data.type==='create'){const r=makeRoom();join(ws,r,safeName(data.name),null,'player');return;}
  if(data.type==='join'){let id=String(data.room||'').trim().toUpperCase();const r=rooms.get(id);if(!r)throw new Error('존재하지 않거나 종료된 방입니다.');join(ws,r,safeName(data.name),typeof data.token==='string'?data.token:null,data.spectator?'spectator':'player');return;}
  if(data.type==='leave'){detach(ws);send(ws,{type:'left'});return;}
  const {meta,r}=active(ws),seat=meta.role;
  if(data.type==='place'){if(typeof seat!=='number')throw new Error('관전자는 착수할 수 없습니다.');if(r.winner||r.draw)throw new Error('대국이 종료되었습니다.');if(occupied(r)<2)throw new Error('상대 플레이어 입장을 기다려주세요.');if(!r.players[0]?.ws||!r.players[1]?.ws)throw new Error('상대방이 연결되지 않았습니다.');if(r.turn!==seat)throw new Error('상대방 차례입니다.');const i=data.index;if(!Number.isInteger(i)||i<0||i>=225||r.board[i])throw new Error('둘 수 없는 자리입니다.');r.board[i]=seat;r.moves.push(i);r.pendingUndo=null;r.rematch.clear();if(checkWin(r.board,i,seat)){r.winner=seat;r.score[seat-1]++;}else if(r.moves.length===225){r.draw=true;}else r.turn=3-seat;publish(r);return;}
  if(data.type==='undo_request'){if(typeof seat!=='number'||r.moves.length===0||r.winner||r.draw)throw new Error('지금은 무르기를 요청할 수 없습니다.');if(!r.players[2-seat]?.ws)throw new Error('상대방이 접속 중이지 않습니다.');if(r.pendingUndo)throw new Error('이미 대기 중인 요청이 있습니다.');r.pendingUndo=seat;publish(r);return;}
  if(data.type==='undo_answer'){if(typeof seat!=='number'||r.pendingUndo!==3-seat)throw new Error('답변할 무르기 요청이 없습니다.');if(data.accept===true){const last=r.moves.pop();r.board[last]=0;r.turn=3-seat;}r.pendingUndo=null;publish(r);return;}
  if(data.type==='rematch'){if(typeof seat!=='number')throw new Error('관전자는 재대결을 신청할 수 없습니다.');if(!r.winner&&!r.draw)throw new Error('대국 종료 후 신청할 수 있습니다.');r.rematch.add(seat);if(r.rematch.size===2){r.round++;r.board=Array(225).fill(0);r.moves=[];r.winner=0;r.draw=false;r.turn=(r.round%2===1)?1:2;r.rematch.clear();r.pendingUndo=null;}publish(r);return;}
  if(data.type==='chat'){const message=String(data.message||'').trim().slice(0,120);if(message)broadcast(r,{type:'chat',name:typeof seat==='number'?r.players[seat-1]?.name:'관전자',message});return;}
}catch(e){error(ws,e?.message||'처리 중 오류가 발생했습니다.');}});ws.on('close',()=>detach(ws));ws.on('error',()=>{});});
const interval=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}for(const [ticket,t] of tickets){if(now()-t.started>14400000)tickets.delete(ticket);}for(const [ip,v] of rate){if(now()-v.since>2*minute)rate.delete(ip);}for(const [id,r] of rooms){if(!sockets(r).some(ws=>ws.readyState===WebSocket.OPEN)&&now()-r.updated>ROOM_TTL)rooms.delete(id);}},CLEAN_INTERVAL);
server.listen(PORT,'0.0.0.0',()=>console.log(`삐약 오목 서버: ${PORT}`));
process.on('SIGTERM',()=>{clearInterval(interval);wss.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
