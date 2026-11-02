/* Shared by local play and the authoritative room server. */
(function(root){
function createRules({getPlayers,getState,hooks={},random=Math.random,uid:initialUid=0}){
let uid=initialUid;
const noop=()=>{};
const {markBorn=noop,log=noop,logP=noop,floatCoin=noop}=hooks;
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const ACTIONS=['feed','mate','buy','sell'];
const SIZES=['piglet','small','average','big'];
const VAL={piglet:3,small:6,average:10,big:15};
/* footprints from the real tiles' proportions: piglet/average square, small 3:2, big 4:3 */
const SPAN={piglet:[2,2],small:[3,2],average:[3,3],big:[4,3]}; // [w,h] on the 16×8 fine grid
const NEXT={piglet:'small',small:'average',average:'big'};
const ITEM_PRICE={vaccine:1,supplement:1,amulet:1};
const FW=16, FH=8;
const fieldPrice=n=>n<=1?0:10+5*(n-2); // 2nd $10, 3rd $15, 4th $20, +$5…
function mkPlayer(name,human){
  return {name,human,coins:45,fields:[{bx:0,by:0}],pigs:[],items:{vaccine:0,supplement:0,amulet:0},soldThisRound:0};
}
function mkPig(size){return {id:++uid,size,vacc:false,x:0,y:0,fedRound:-1,matedRound:-1}}

function pasture(p){
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for(const b of p.fields){ if(b.bx<minx)minx=b.bx; if(b.by<miny)miny=b.by;
    if(b.bx+FW>maxx)maxx=b.bx+FW; if(b.by+FH>maxy)maxy=b.by+FH; }
  const W=maxx-minx, H=maxy-miny;
  const farm=Array.from({length:H},()=>Array(W).fill(false));
  for(const b of p.fields) for(let y=0;y<FH;y++)for(let x=0;x<FW;x++) farm[b.by-miny+y][b.bx-minx+x]=true;
  return {minx,miny,W,H,farm};
}
/* keep the top-left board at (0,0); shift pigs with it so coords stay non-negative */
function normalize(p){
  let minx=Infinity,miny=Infinity;
  for(const b of p.fields){ if(b.bx<minx)minx=b.bx; if(b.by<miny)miny=b.by; }
  if(!isFinite(minx)||(!minx&&!miny)) return;
  for(const b of p.fields){ b.bx-=minx; b.by-=miny; }
  for(const pg of p.pigs){ pg.x-=minx; pg.y-=miny; }
}
function addField(p){
  const right=p.fields.reduce((a,b)=>b.bx>a.bx?b:a);
  p.fields.push({bx:right.bx+FW,by:right.by}); normalize(p);
}
function occGrid(p,ignoreId){
  const {W,H}=pasture(p);
  const g=Array.from({length:H},()=>Array(W).fill(false));
  for(const pg of p.pigs){ if(pg.id===ignoreId) continue;
    const [w,h]=SPAN[pg.size];
    for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){ const yy=pg.y+dy,xx=pg.x+dx;
      if(yy>=0&&yy<H&&xx>=0&&xx<W) g[yy][xx]=true; }}
  return g;
}
/* a pig fits at (x,y) iff every covered cell is farmable and unoccupied */
function canPlaceAt(p,x,y,size,ignoreId){
  const [w,h]=SPAN[size]; const {W,H,farm}=pasture(p);
  if(x<0||y<0||x+w>W||y+h>H) return false;
  const g=occGrid(p,ignoreId);
  for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){ if(!farm[y+dy][x+dx]||g[y+dy][x+dx]) return false; }
  return true;
}
function findSpot(p,size,ignoreId){
  const [w,h]=SPAN[size]; const {W,H,farm}=pasture(p); const g=occGrid(p,ignoreId);
  for(let y=0;y<=H-h;y++)for(let x=0;x<=W-w;x++){
    let ok=true;
    for(let dy=0;dy<h&&ok;dy++)for(let dx=0;dx<w&&ok;dx++){ if(!farm[y+dy][x+dx]||g[y+dy][x+dx]) ok=false; }
    if(ok) return {x,y};
  }
  return null;
}
/* greedy repack: place pigs largest-first onto the farmable region; positions or null */
function packAll(p,extraSizes,grow){
  const list=p.pigs.map(pg=>({id:pg.id,size:pg.id===(grow&&grow.id)?grow.size:pg.size}));
  (extraSizes||[]).forEach((s,k)=>list.push({id:'new'+k+'_'+Math.abs(uid+list.length),size:s,isNew:true}));
  const area=s=>SPAN[s][0]*SPAN[s][1];
  list.sort((a,b)=>area(b.size)-area(a.size));
  const {W,H,farm}=pasture(p);
  const used=Array.from({length:H},()=>Array(W).fill(false));
  const pos={};
  for(const it of list){
    const [w,h]=SPAN[it.size]; let placed=false;
    for(let y=0;y<=H-h&&!placed;y++)
      for(let x=0;x<=W-w&&!placed;x++){
        let ok=true;
        for(let dy=0;dy<h&&ok;dy++)for(let dx=0;dx<w&&ok;dx++){ if(!farm[y+dy][x+dx]||used[y+dy][x+dx]) ok=false; }
        if(ok){ for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++) used[y+dy][x+dx]=true;
          pos[it.id]={x,y}; placed=true; }
      }
    if(!placed) return null;
  }
  return pos;
}
function applyPack(p,pos){ p.pigs.forEach(pg=>{ const q=pos[pg.id]; if(q){pg.x=q.x;pg.y=q.y;} }); }
/* try to place a new pig: direct spot, else full repack */
function acquirePig(p,size){
  const spot=findSpot(p,size);
  if(spot){ const pg=mkPig(size); Object.assign(pg,spot); p.pigs.push(pg); return pg; }
  const pos=packAll(p,[size]);
  if(pos){ applyPack(p,pos); const nk=Object.keys(pos).find(k=>String(k).startsWith('new'));
    const pg=mkPig(size); Object.assign(pg,pos[nk]); p.pigs.push(pg); return pg; }
  return null;
}
function canFitNew(p,size){ return !!(findSpot(p,size)||packAll(p,[size])); }
/* grow a pig one step; keeps anchor if possible, else repack; false if impossible */
function growPig(p,pg){
  const ns=NEXT[pg.size]; if(!ns) return false;
  if(canPlaceAt(p,pg.x,pg.y,ns,pg.id)){ pg.size=ns; return true; }
  const spot=findSpot(p,ns,pg.id); if(spot){ pg.size=ns; Object.assign(pg,spot); return true; }
  const pos=packAll(p,null,{id:pg.id,size:ns});
  if(pos){ pg.size=ns; applyPack(p,pos); return true; }
  return false;
}
function canGrow(p,pg){ const ns=NEXT[pg.size]; if(!ns) return false;
  return canPlaceAt(p,pg.x,pg.y,ns,pg.id)||!!findSpot(p,ns,pg.id)||!!packAll(p,null,{id:pg.id,size:ns}); }
/* snapshot/restore board+pig coords, so a rejected board move can revert cleanly */
function snapPlay(p){ return {fields:p.fields.map(b=>({bx:b.bx,by:b.by})),
  pigs:p.pigs.map(pg=>({id:pg.id,x:pg.x,y:pg.y}))}; }
function restorePlay(p,s){ p.fields.forEach((b,i)=>{ b.bx=s.fields[i].bx; b.by=s.fields[i].by; });
  const m={}; s.pigs.forEach(q=>m[q.id]=q);
  p.pigs.forEach(pg=>{ const q=m[pg.id]; if(q){ pg.x=q.x; pg.y=q.y; } }); }

const EFFECTS={
  calm:{txt:'Calm season — no effect.',run:()=>{}},
  love:{txt:'Season of Love — 1 free Piglet per pair of Average/Big pigs (if it fits).',run:(p,i)=>{
    const pairs=Math.floor(p.pigs.filter(x=>x.size==='average'||x.size==='big').length/2);
    let got=0; for(let k=0;k<pairs;k++){ const pg=acquirePig(p,'piglet'); if(pg){got++; markBorn(i,pg);} }
    if(pairs&&!got) log('sys',`${esc(p.name)} had no room for love-piglets.`);
    else if(got) logP(i,`${esc(p.name)} gained ${got} piglet(s) from the Season of Love.`);
  }},
  subsidy:{txt:'Farm subsidy — gain $1 per Piglet you own.',run:(p,i)=>{
    const n=p.pigs.filter(x=>x.size==='piglet').length;
    if(n){p.coins+=n; floatCoin(i,n); logP(i,`${esc(p.name)} got $${n} subsidy.`);}
  }},
  boom:{txt:'Market boom — gain $1 per pig you sold this round.',run:(p,i)=>{
    if(p.soldThisRound){p.coins+=p.soldThisRound; floatCoin(i,p.soldThisRound);
      logP(i,`${esc(p.name)} got $${p.soldThisRound} market bonus.`);}
  }},
  gift:{txt:'Vet visit — each farmer gets 1 free Vaccine.',run:(p,i)=>{p.items.vaccine++;}},
};
function buildDeck(){
  const pick=(arr)=>arr[Math.floor(random()*arr.length)];
  const deck=[];
  for(let s=0;s<4;s++){
    const pool=s===1?['love','love','calm','subsidy','boom','gift']:['calm','calm','subsidy','boom','gift','love'];
    for(let c=0;c<4;c++){
      deck.push({season:s,
        qty:{feed:6+Math.floor(random()*4),mate:6+Math.floor(random()*4),
             buy:6+Math.floor(random()*4),sell:6+Math.floor(random()*4)},
        effect:pick(pool)});
    }
  }
  return deck;
}
function doBuy(i,k){
  const p=getPlayers()[i];
  if(k==='field'){ const c=fieldPrice(p.fields.length+1); if(p.coins<c) return false;
    p.coins-=c; addField(p); floatCoin(i,-c);
    logP(i,`${esc(p.name)} bought field #${p.fields.length} ($${c}).`); return true; }
  if(ITEM_PRICE[k]!==undefined){ if(p.coins<ITEM_PRICE[k]) return false;
    p.coins-=ITEM_PRICE[k]; p.items[k]++; floatCoin(i,-ITEM_PRICE[k]);
    logP(i,`${esc(p.name)} bought a ${k} ($${ITEM_PRICE[k]}).`); return true; }
  if(VAL[k]===undefined||p.coins<VAL[k]) return false;
  const pg=acquirePig(p,k);
  if(!pg){ log('sys',`${esc(p.name)} couldn't fit a ${k} — purchase cancelled.`); return false; }
  p.coins-=VAL[k]; floatCoin(i,-VAL[k]); markBorn(i,pg);
  logP(i,`${esc(p.name)} bought a ${k} ($${VAL[k]}).`);
  return true;
}
function distribute(card,choices){
  const allot=new Array(getPlayers().length).fill(0);
  ACTIONS.forEach(a=>{
    const group=[];
    for(let k=0;k<getPlayers().length;k++){ const i=(getState().startIdx+k)%getPlayers().length; if(choices[i]===a) group.push(i); }
    if(!group.length) return;
    let pool=card.qty[a];
    while(pool>0){ let gave=false;
      for(const i of group){ if(pool<=0) break; allot[i]++; pool--; gave=true; }
      if(!gave) break; }
  });
  return allot;
}

function variedBest(items,score,maxGap=0,chance=.25){
  if(!items.length) return null;
  const ranked=[...items].sort((a,b)=>score(b)-score(a));
  const best=score(ranked[0]);
  const alternatives=ranked.slice(1).filter(x=>best-score(x)<=maxGap);
  if(alternatives.length&&random()<chance)
    return alternatives[Math.floor(random()*alternatives.length)];
  return ranked[0];
}
function aiPick(i){
  const p=getPlayers()[i];
  const seasonRound=getState().round;             // 1..4 within season
  const finalSeason=getState().season===3;
  const growable=p.pigs.filter(x=>canGrow(p,x)&&x.fedRound!==getState().roundSerial);
  const mateable=p.pigs.filter(x=>(x.size==='average'||x.size==='big')&&x.matedRound!==getState().roundSerial);
  const needVacc=p.pigs.filter(x=>!x.vacc&&VAL[x.size]>=6).length;
  // near season end: secure vaccines for valuable pigs
  if(seasonRound>=3&&needVacc>p.items.vaccine&&p.coins>=needVacc-p.items.vaccine) return 'buy';
  if(p.coins<4&&p.pigs.length>1) return 'sell';
  const options=[];
  if(growable.length) options.push({action:'feed',score:growable.length>=2?3:2});
  if(mateable.length>=2&&canFitNew(p,'piglet')) options.push({action:'mate',score:3});
  if(p.coins>=6&&!finalSeason) options.push({action:'buy',score:2});
  if(p.pigs.length) options.push({action:'sell',score:1});
  return (variedBest(options,x=>x.score)||{action:'buy'}).action;
}

return {SIZES,VAL,SPAN,NEXT,ITEM_PRICE,FW,FH,fieldPrice,mkPlayer,mkPig,pasture,normalize,addField,occGrid,canPlaceAt,findSpot,packAll,applyPack,acquirePig,canFitNew,growPig,canGrow,snapPlay,restorePlay,EFFECTS,buildDeck,doBuy,distribute,variedBest,aiPick,getUid:()=>uid};
}
if(typeof module!=="undefined"&&module.exports) module.exports={createRules};
else root.HappyPigsRules={createRules};
})(globalThis);
