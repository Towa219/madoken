// ステージが進んだとき、魔法の再使用時間がリセットされるかを確かめる。
//
// サーバーは nextStage で0に戻していたが、画面側の残り時間はそのままだった。
// そのため次のステージが始まっても魔法ボタンが灰色のまま押せなかった。
//
// 再使用の短い魔法だとカウントダウン(3.6秒)の間に自然に切れてしまい差が出ない。
// ここでは再使用40秒の封印を使い、確実に持ち越される状況で見る。
//
//   npx tsx test/coop_cooldown_reset_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const HTTP='http://127.0.0.1:2567', CHROME=process.env.CHROME_PATH??'', PORT=9405;
const sleep=(m:number)=>new Promise(r=>setTimeout(r,m));
class Cdp{ private ws!:WebSocket; private id=0; private w=new Map<number,(v:any)=>void>();
  async connect(u:string){this.ws=new WebSocket(u);
    await new Promise<void>((res,rej)=>{this.ws.onopen=()=>res();this.ws.onerror=()=>rej(new Error('x'))});
    this.ws.onmessage=e=>{const m=JSON.parse(String(e.data));const f=this.w.get(m.id);if(f){this.w.delete(m.id);f(m);}};}
  send(method:string,params:unknown={}){const id=++this.id;
    return new Promise<any>(res=>{this.w.set(id,res);this.ws.send(JSON.stringify({id,method,params}));});}
  async ev<T>(e:string){const r=await this.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value as T;}
  async click(sel:string){const b=await this.ev<any>(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if(!b)return false; for(const t of ['mousePressed','mouseReleased']) await this.send('Input.dispatchMouseEvent',{type:t,x:b.x,y:b.y,button:'left',clickCount:1}); await sleep(400); return true;}
  close(){this.ws.close();}}
const NAME=`cr${Math.random().toString(36).slice(2,6)}`;
const save={version:1,nickname:NAME,nickToken:`tok_${NAME}`,charId:0,researchP:200,
  inventory:{fire:5,water:5,wind:5,earth:5,thunder:5,ice:5,light:5,dark:5},
  spells:[
    {id:'s1',name:'強い魔弾',recipe:{fire:1,water:1,light:2,dark:2},discoveries:[],level:9,rarity:'legend',stats:{},equipCount:2},
    {id:'s2',name:'封印',recipe:{dark:3},discoveries:[],level:0,rarity:'normal',stats:{},equipCount:1}],
  equipped:['s1','s2'], discovered:[], slots:5, maxStage:1, bestStage:0,
  bossCleared:[], sortMode:'use', codexRewarded:false, legendRewarded:false};
let bad=0;
const ck=(l:string,ok:boolean,d='')=>{console.log(`  ${ok?'OK ':'NG '} ${l}${d?' — '+d:''}`); if(!ok)bad++;};
(async()=>{
  const prof=mkdtempSync(join(tmpdir(),'cr-'));
  const ch=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${prof}`,'--no-first-run','--hide-scrollbars','--window-size=1280,900','about:blank'],{stdio:'ignore'});
  const c=new Cdp();
  try{
    let u=''; for(let i=0;i<40&&!u;i++){await sleep(500);
      try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json() as any);u=l.find((t:any)=>t.type==='page')?.webSocketDebuggerUrl??'';}catch{}}
    await c.connect(u); await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`try{localStorage.setItem('magic_web_game_save_v1',${JSON.stringify(JSON.stringify(save))});localStorage.setItem('madoken_sound_v3',JSON.stringify({bgmVolume:0,sfxVolume:0,muted:true}))}catch{}`});
    await c.send('Page.navigate',{url:HTTP});
    for(let i=0;i<60;i++){if(await c.ev<boolean>('document.readyState==="complete"'))break;await sleep(250);} await sleep(3000);
    await c.click('#tab-online'); await sleep(2500);
    await c.click('#btn-create-room'); await sleep(2500);
    await c.click('#btn-coop-ready');
    for(let i=0;i<60;i++){ if(await c.ev<boolean>('document.querySelector("#coop-waiting")?.classList.contains("hidden")===true'))break; await sleep(500);}
    await sleep(4500);
    // ステージ番号はcanvasに描かれるのでDOMからは読めない。
    // クリアの知らせ(トースト)で切り替わりを見つける。
    const toast=()=>c.ev<string>('document.querySelector("#toast")?.textContent ?? ""');
    const btns=()=>c.ev<any>(`(()=>{const b=[...document.querySelectorAll('#coop-bar .spell-btn')];
      return { 個数:b.length, 押せる:b.filter(x=>!x.disabled).length,
        待ち:b.map(x=>x.querySelector('.cd-overlay')?.style.width||'0%') };})()`);
    const press=async()=>{ for(const t of ['keyDown','keyUp']) await c.send('Input.dispatchKeyEvent',{type:t,text:t==='keyDown'?'1':undefined,key:'1',code:'Digit1',windowsVirtualKeyCode:49}); };

    // まず再使用40秒の封印(キー2)を撃つ。これが次のステージへ持ち越されると、
    // 開幕で押せないままになる。
    for(const t of ['keyDown','keyUp']) await c.send('Input.dispatchKeyEvent',{type:t,text:t==='keyDown'?'2':undefined,key:'2',code:'Digit2',windowsVirtualKeyCode:50});
    await sleep(2500);
    const afterSeal = await btns();
    ck('封印を撃った直後は押せない(再使用中)', afterSeal.押せる < afterSeal.個数,
      `押せる${afterSeal.押せる}/${afterSeal.個数} 残り${JSON.stringify(afterSeal.待ち)}`);

    const end=Date.now()+120000; let moved=false;
    while(Date.now()<end){
      await press(); await sleep(400);
      if(/ステージ\s*\d+\s*クリア/.test(await toast())){ moved=true; break; }
    }
    ck('ステージをクリアして次へ進んだ', moved, moved?await toast():'クリアできなかった');

    // 次のステージが始まるまで(カウントダウン込み)待ち、押せるようになるか見る
    let ok=false; let last:any=null;
    for(let i=0;i<40;i++){
      await sleep(500);
      last = await btns();
      if(last.個数>0 && last.押せる===last.個数){ ok=true; break; }
    }
    console.log(`     ボタン: ${last.個数}個 押せる${last.押せる}個 再使用の残り${JSON.stringify(last.待ち)}`);
    ck('★次のステージ開幕で魔法ボタンが押せる', ok);
    const st = last;
    ck('再使用の待ち表示も空になっている', st.待ち.every((w:string)=>w==='0%'||w===''), JSON.stringify(st.待ち));
  } finally { c.close(); ch.kill(); await sleep(300); try{rmSync(prof,{recursive:true,force:true})}catch{}
    try{await fetch(HTTP+'/api/name/release',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:NAME,token:`tok_${NAME}`})})}catch{} }
  console.log(bad?`\n=== ${bad}件 失敗 ===`:'\n=== 合格 ===');
  process.exit(bad?1:0);
})();
