// ボス戦を繰り返し走らせて、サーバーが死ぬかを見る。
//
//   npx tsx test/boss_hammer.ts [分] [人数]
//   MADOKEN_TARGET=http://localhost:2568 npx tsx test/boss_hammer.ts 5 1
//
// ★ 「ボス戦でしか落ちたことがない。起動直後でも落ちる」という証言に
//   合わせた形。長く繋ぐことではなく、ボス戦そのものを何度も通す。
//
// ★ サーバーが死んだかどうかは /api/ping の稼働時間で見る。
//   自分の接続が切れただけなのか、サーバーごと落ちたのかを、
//   ここで必ず分けること。分けないと原因の見当が180度変わる。
//
// ★ 死んだら lastExit を読む。サーバー自身が書き残した終わり方で、
//   「プラットフォームが止めた/こちらの例外/書く暇もなく殺された」
//   の3つに分かれる(server/index.ts)。

import { Client } from 'colyseus.js';
import { releaseTestNames } from './testnames';
import type { TestName } from './testnames';

const 的 = process.env.MADOKEN_TARGET ?? 'https://madoken.onrender.com';
const 分 = Math.max(1, Number(process.argv[2] ?? 10));
const 人数 = Math.max(1, Math.min(3, Number(process.argv[3] ?? 1)));
const 開始段 = Number(process.env.STAGE ?? 5);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const 使った名前: TestName[] = [];
const 時刻 = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });

// 深いボスまで進めるだけの火力。目的は「ボス戦を何度も通すこと」。
const 魔法 = [
  { name: '爆炎', recipe: { fire: 3 }, level: 9, rarity: 'legend' },
  { name: '聖光', recipe: { light: 3 }, level: 9, rarity: 'legend' },
  { name: '大地', recipe: { earth: 2, wind: 1 }, level: 9, rarity: 'legend' },
  { name: '氷嵐', recipe: { ice: 2, water: 1 }, level: 9, rarity: 'legend' },
];

async function 本番の様子(): Promise<{ uptime: number; lastExit: string; rssMB: number } | null> {
  try {
    return await fetch(`${的}/api/ping`, { signal: AbortSignal.timeout(15000) })
      .then(r => r.json()) as any;
  } catch { return null; }
}

async function 一戦(回: number): Promise<{ 段: number; 終わり方: string; 切れた: string }> {
  const 部屋たち: any[] = [];
  let 切れた = '';
  let 部屋ID = '';
  try {
    for (let i = 0; i < 人数; i++) {
      const 名 = `h${Math.random().toString(36).slice(2, 6)}`;
      使った名前.push({ name: 名, token: `tok_${名}` });
      const client = new Client(的.replace(/^http/, 'ws'));
      const 入る = {
        name: 名, nickToken: `tok_${名}`, maxStage: 50,
        stage: 開始段, charId: i, spells: 魔法,
      };
      const 部屋 = i === 0
        ? await client.create('coop', 入る)
        : await client.joinById(部屋ID, 入る);
      if (i === 0) 部屋ID = 部屋.roomId;
      部屋.onLeave((code: number) => { if (!切れた) 切れた = `code=${code}`; });
      部屋.onError((code: number, m?: string) => { if (!切れた) 切れた = `error ${code} ${m ?? ''}`; });
      部屋たち.push(部屋);
      await sleep(250);
    }
    for (const 部屋 of 部屋たち) 部屋.send('ready', {});

    let 最高段 = 開始段;
    const 期限 = Date.now() + 180_000;   // 1戦は最長3分
    while (Date.now() < 期限 && !切れた) {
      await sleep(350);
      const st = (部屋たち[0].state as any);
      const 相 = st?.phase ?? '';
      if (typeof st?.stage === 'number' && st.stage > 最高段) 最高段 = st.stage;
      if (相 === 'done') return { 段: 最高段, 終わり方: '全滅', 切れた };
      if (相 === 'fight') {
        for (const 部屋 of 部屋たち) {
          try { 部屋.send('cast', { idx: Math.floor(Math.random() * 4) }); } catch { /* 切れた */ }
        }
      }
    }
    return { 段: 最高段, 終わり方: 切れた ? '切断' : '時間切れ', 切れた };
  } finally {
    for (const 部屋 of 部屋たち) { try { await 部屋.leave(); } catch { /* 済み */ } }
  }
}

async function main(): Promise<void> {
  console.log('=== ボス戦を叩き続ける ===');
  console.log(`  ${的} / ステージ${開始段}から / ${人数}人 / ${分}分`);
  const 初め = await 本番の様子();
  console.log(`  開始時: 稼働${初め?.uptime ?? '?'}秒 メモリ${初め?.rssMB ?? '?'}MB`);
  let 前の稼働 = 初め?.uptime ?? 0;

  const 期限 = Date.now() + 分 * 60_000;
  let 回 = 0;
  let 死んだ = false;
  try {
    while (Date.now() < 期限 && !死んだ) {
      回++;
      const r = await 一戦(回);
      const 様子 = await 本番の様子();
      const 稼働 = 様子?.uptime ?? 0;
      // ★ ここが肝。稼働時間が戻っていればサーバーごと落ちている。
      死んだ = 様子 !== null && 稼働 < 前の稼働;
      console.log(`  ${時刻()} ${回}戦目: ステージ${r.段}まで / ${r.終わり方}`
        + `${r.切れた ? `(${r.切れた})` : ''} / 稼働${稼働}秒 メモリ${様子?.rssMB ?? '?'}MB`);
      if (死んだ) {
        console.log('');
        console.log(`  ★★★ サーバーが死にました(稼働${前の稼働}秒 → ${稼働}秒)`);
        console.log(`  前回の終わり方: ${様子?.lastExit ?? '(読めない)'}`);
        console.log('');
      }
      前の稼働 = 稼働;
      await sleep(1500);
    }
  } finally {
    await releaseTestNames(的, 使った名前);
  }

  console.log('');
  console.log(死んだ
    ? '=> ボス戦でサーバーを落とせました。上の「終わり方」が原因を指します。'
    : `=> ${回}戦してもサーバーは死にませんでした。`);
  await sleep(400);
}

void main();
