import crypto from 'node:crypto';
const OWNER=process.env.GITHUB_OWNER||'', REPO=process.env.GITHUB_REPO||'', BRANCH=process.env.GITHUB_BRANCH||'main';
const TOKEN=process.env.GITHUB_TOKEN||'', DIR=(process.env.GITHUB_RECORDS_DIR||'records').replace(/^\/+|\/+$/g,'');
const ready=Boolean(OWNER&&REPO&&TOKEN);
const tickets=new Map();let queue=Promise.resolve();
const headers={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'bbiyak-galaga'};
const path=`${DIR}/galaga.json`;
const url=`https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':process.env.ALLOWED_ORIGIN||'*'});res.end(JSON.stringify(obj));};
async function gh(uri,options={}){const controller=new AbortController();const t=setTimeout(()=>controller.abort(),12000);try{return await fetch(uri,{...options,headers:{...headers,...options.headers},signal:controller.signal});}finally{clearTimeout(t);}}
async function read(){const r=await gh(url+'?ref='+encodeURIComponent(BRANCH));if(r.status===404)return {sha:null,records:[]};if(!r.ok)throw Error('GitHub 읽기 실패 '+r.status);const file=await r.json();const raw=Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8');const v=JSON.parse(raw);const records=(Array.isArray(v.records)?v.records:[]).filter(x=>typeof x.name==='string'&&Number.isSafeInteger(x.score)&&x.score>=0).slice(0,1000);return {sha:file.sha,records};}
function ranking(records){return records.slice().sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'ko')).slice(0,100).map((r,i)=>({rank:i+1,...r}));}
async function writeBest(item){for(let i=0;i<5;i++){const cur=await read();const old=cur.records.find(x=>x.name.toLocaleLowerCase('ko')===item.name.toLocaleLowerCase('ko'));if(old&&old.score>=item.score)return {newBest:false,ranking:ranking(cur.records)};const records=cur.records.filter(x=>x.name.toLocaleLowerCase('ko')!==item.name.toLocaleLowerCase('ko'));records.push(item);const data={message:`records: galaga ${item.name} ${item.score}`,branch:BRANCH,content:Buffer.from(JSON.stringify({version:1,records},null,2)+'\n').toString('base64')};if(cur.sha)data.sha=cur.sha;const r=await gh(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(r.ok)return {newBest:true,ranking:ranking(records)};if(r.status===409||r.status===422){await new Promise(resolve=>setTimeout(resolve,150*(i+1)));continue;}throw Error('GitHub 저장 실패 '+r.status);}throw Error('기록 저장 충돌');}
export async function handleGalagaHttp(req,res,urlObj){const route=urlObj.pathname;if(!['/api/galaga/leaderboard','/api/galaga/start','/api/galaga/record'].includes(route))return false;
if(!ready){json(res,503,{error:'GitHub 점수 저장 설정이 필요합니다.'});return true;}
try{
 if(route==='/api/galaga/leaderboard'){if(req.method!=='GET'){json(res,405,{error:'GET only'});return true;}const d=await read();json(res,200,{ranking:ranking(d.records),total:d.records.length});return true;}
 if(req.method!=='POST'){json(res,405,{error:'POST only'});return true;}
 let raw='';for await(const c of req){raw+=c;if(raw.length>2048)throw Error('요청이 너무 큽니다.');}const d=JSON.parse(raw||'{}');
 if(route==='/api/galaga/start'){const ticket=crypto.randomBytes(24).toString('hex');tickets.set(ticket,{started:Date.now(),used:false});json(res,200,{ticket});return true;}
 const t=tickets.get(String(d.ticket||'')),name=String(d.name||'').trim().replace(/[<>"'`\\\r\n]/g,'').slice(0,16),score=Number(d.score),stage=Number(d.stage);
 if(!name||!t||t.used||!Number.isSafeInteger(score)||score<0||!Number.isInteger(stage)||stage<1||stage>10000)throw Error('점수 데이터가 올바르지 않습니다.');
 const sec=(Date.now()-t.started)/1000;if(sec<8||sec>14400)throw Error('플레이 시간이 올바르지 않습니다.');
 // Basic server-side sanity limits; browser-based arcade scores are not cryptographically cheat-proof.
 if(score>Math.ceil(sec*400+3000)||stage>Math.ceil(sec/8)+2)throw Error('플레이 시간에 비해 점수가 지나치게 높습니다.');
 t.used=true;const job=queue.catch(()=>{}).then(()=>writeBest({name,score,stage,at:new Date().toISOString()}));queue=job.catch(()=>{});
 try{const result=await job;tickets.delete(String(d.ticket));json(res,200,{saved:true,score,...result});}catch(e){t.used=false;throw e;}
 return true;
}catch(e){json(res,400,{error:e.message||'기록 오류'});return true;}
}
setInterval(()=>{const n=Date.now();for(const [k,v] of tickets)if(n-v.started>14400000)tickets.delete(k);},60000).unref();
