// Janggi: 9x10 board. 1=Han(bottom, first), 2=Cho(top).
const at=(x,y)=>x>=0&&x<9&&y>=0&&y<10;
const palace=(x,y,side)=>x>=3&&x<=5&&(side===1?y>=7&&y<=9:y>=0&&y<=2);
const center=(x,y)=>x===4&&(y===1||y===8);
const pside=p=>p?p[0]==='h'?1:2:0;
const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
const palaceEdges=(x,y)=>{const out=[];for(const [dx,dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]){const xx=x+dx,yy=y+dy;if(xx<3||xx>5||!((yy>=0&&yy<=2)||(yy>=7&&yy<=9)))continue;const same=(y<=2&&yy<=2)||(y>=7&&yy>=7);if(same&&(center(x,y)||center(xx,yy)))out.push([xx,yy]);}return out;};
const SETUPS=new Set(['heeh','hehe','eheh','ehhe']);
export function init(layouts={}){const b=Array(90).fill('');const top=['cr','','','ca','','ca','','','cr'];
 const arrange=(side,layout,row)=>{const letters=SETUPS.has(layout)?layout:'ehhe';for(const [i,x] of [1,2,6,7].entries())b[row*9+x]=(side===1?'h':'c')+letters[i];};
 for(let x=0;x<9;x++){if(top[x]){b[x]=top[x];b[81+x]='h'+top[x].slice(1);}}
 arrange(2,layouts[2],0);arrange(1,layouts[1],9);b[13]='ck';b[76]='hk';b[19]='cc';b[25]='cc';b[64]='hc';b[70]='hc';for(const x of [0,2,4,6,8]){b[27+x]='cs';b[54+x]='hs';}return {b,t:1,half:0};}
function raw(s,f){const b=s.b,p=b[f];if(!p)return [];const who=pside(p),x=f%9,y=Math.floor(f/9),type=p[1],out=[];const add=(xx,yy)=>{if(at(xx,yy)&&pside(b[yy*9+xx])!==who)out.push(yy*9+xx);};
 if(type==='s'){for(const [dx,dy] of [[-1,0],[1,0],[0,who===1?-1:1]])add(x+dx,y+dy);for(const [xx,yy] of palaceEdges(x,y))if((who===1?yy<y:yy>y))add(xx,yy);}
 if(type==='k'||type==='a'){for(const [dx,dy] of dirs){const xx=x+dx,yy=y+dy;if(palace(xx,yy,who))add(xx,yy);}for(const [xx,yy] of palaceEdges(x,y))if(palace(xx,yy,who))add(xx,yy);}
 if(type==='h'||type==='e'){for(const [dx,dy] of dirs){const ax=x+dx,ay=y+dy;if(!at(ax,ay)||b[ay*9+ax])continue;const bends=dx?[ [dx,1],[dx,-1] ]:[[1,dy],[-1,dy]];for(const [bx,by] of bends){const mx=ax+bx,my=ay+by;if(!at(mx,my))continue;if(type==='h')add(mx,my);else if(!b[my*9+mx]){add(mx+bx,my+by);}}}}
 if(type==='r'||type==='c'){
  const rays=dirs.map(([dx,dy])=>{let ray=[];for(let xx=x+dx,yy=y+dy;at(xx,yy);xx+=dx,yy+=dy)ray.push([xx,yy]);return ray;});
  // The palace diagonal is available only along its drawn diagonal lines.
  for(const [dx,dy] of [[1,1],[-1,1],[1,-1],[-1,-1]]){let ray=[],xx=x,yy=y;while(true){let next=palaceEdges(xx,yy).find(a=>a[0]===xx+dx&&a[1]===yy+dy);if(!next)break;[xx,yy]=next;ray.push([xx,yy]);}if(ray.length)rays.push(ray);}
  for(const ray of rays){let screen=false;for(const [xx,yy] of ray){const q=b[yy*9+xx];if(type==='r'){if(pside(q)===who)break;add(xx,yy);if(q)break;}else{if(!screen){if(q){if(q[1]==='c')break;screen=true;} }else{if(q&&q[1]==='c')break;if(q){if(pside(q)!==who)add(xx,yy);break;}add(xx,yy);}}}}
 }return out;}
function check(s,who){const king=s.b.indexOf(who===1?'hk':'ck');if(king<0)return true;const enemy=3-who;const other=s.b.indexOf(enemy===1?'hk':'ck');if(other>=0&&other%9===king%9){let clear=true;for(let y=Math.min(Math.floor(king/9),Math.floor(other/9))+1;y<Math.max(Math.floor(king/9),Math.floor(other/9));y++)if(s.b[y*9+king%9])clear=false;if(clear)return true;}
 for(let i=0;i<90;i++)if(pside(s.b[i])===enemy&&raw(s,i).includes(king))return true;return false;}
export function legal(s){const choices=[];for(let i=0;i<90;i++)if(pside(s.b[i])===s.t)for(const j of raw(s,i)){const t=apply(s,i,j);if(!check(t,s.t))choices.push([i,j]);}return choices;}
function apply(s,i,j){const b=s.b.slice(),piece=b[i],taken=b[j];b[i]='';b[j]=piece;return {b,t:3-s.t,half:taken?0:s.half+1};}
export function snapshot(s){return {board:s.b,turn:s.t,check:check(s,s.t),options:legal(s).map(([f,t])=>f+':'+t)};}
export function move(s,d){const from=Number(d.from),to=Number(d.to);if(!legal(s).some(x=>x[0]===from&&x[1]===to))throw Error('장기 규칙상 둘 수 없는 수입니다.');return {state:apply(s,from,to),label:from+':'+to};}
export function status(s,history){if(!legal(s).length)return {winner:3-s.t,draw:false,reason:check(s,s.t)?'외통수':'둘 수 있는 수 없음'};if(s.half>=200)return {winner:0,draw:true,reason:'100수 무승부'};return {winner:0,draw:false,reason:''};}

export function pass(s){if(check(s,s.t))throw Error('장군 상태에서는 한 수 쉬어갈 수 없습니다.');return {b:s.b.slice(),t:3-s.t,half:s.half+1};}
