// Discordの在室レポートに、その人の到達ステージが入るかを確かめる。
//
// レポートは接続元(IP・地域)しか出しておらず、誰がどこまで進んでいるのかが
// 分からなかった。クリア済みの最高ステージ・持っている魔法の数・発見した系統数を
// 添えるようにした。値はクラウドセーブから読む。
//
// サーバーの中で組み立てないと在室者が分からないので、
// /api/discord-test(ADMIN_KEY必須)に本文を返させて確かめる。
//
//   ADMIN_KEY=testkey npm start
//   npx tsx test/discord_report_stage_check.ts

import { Client } from 'colyseus.js';
const EP='ws://localhost:2567', HTTP='http://localhost:2567';
const R=Math.random().toString(36).slice(2,6);
const sleep=(m:number)=>new Promise(r=>setTimeout(r,m));
(async()=>{
  const name=`dc${R}`, token=`tok_${name}`;
  await fetch(`${HTTP}/api/save`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name,token,savedAt:Date.now(),data:{
      version:1,nickname:name,charId:0,researchP:500,
      inventory:{fire:1,water:1,wind:1,earth:1,thunder:1,ice:1,light:1,dark:1},
      spells:[{id:'a',name:'あ',recipe:{fire:3},discoveries:[],level:0,rarity:'normal'},
              {id:'b',name:'い',recipe:{water:3},discoveries:[],level:0,rarity:'normal'},
              {id:'c',name:'う',recipe:{dark:3},discoveries:[],level:0,rarity:'normal'}],
      equipped:['a'],discovered:['x1','x2','x3','x4','x5','x6','x7','x8'],
      slots:4,maxStage:18,bestStage:17,bossCleared:[10],
      sortMode:'use',codexRewarded:false,legendRewarded:false}})});
  const c=new Client(EP);
  const room=await c.joinOrCreate('lobby_chat',{name,nickToken:token});
  room.onMessage('chat',()=>{});
  await sleep(1500);
  const key=process.env.ADMIN_KEY ?? 'testkey';
  const r=await fetch(`${HTTP}/api/discord-test?key=${key}`).then(x=>x.json() as any);
  console.log('----- 在室レポート -----');
  console.log(r.text ?? '(本文なし)');
  console.log('------------------------');
  const ok = String(r.text||'').includes('ステージ17');
  console.log(ok?'OK 到達ステージが入っている':'NG 到達ステージが入っていない');
  try{ void room.leave(); }catch{}
  await sleep(600);
  for(const u of ['/api/save/delete','/api/name/release'])
    try{ await fetch(HTTP+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,token})}); }catch{}
  process.exit(ok?0:1);
})();
