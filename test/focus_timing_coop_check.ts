// 共闘でも、瞑想の効果が詠唱の「完了時」に出ているかを測る。
//
//   PORT=2568 ADMIN_KEY=test1234 npm run dev:server を先に起こす
//   PET_TEST_URL=http://localhost:2568 npx tsx test/focus_timing_coop_check.ts
//
// ★ 単騎(test/focus_timing_check.ts)とは判定の場所が違う。
//   単騎は端末が数え、共闘はサーバーが数える。片方だけ見て
//   「完了時です」と答えてはいけない。
//
// ★ 見るのは同期される mpRegenBonus。これはサーバーが
//   「効果が効いている間だけ」載せる値なので、立った瞬間が効き始め。

import { Client } from 'colyseus.js';
import { finalStats } from '../shared/spellcraft';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2568';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const 瞑想レシピ = { ice: 2, light: 1 };
const 瞑想 = finalStats(瞑想レシピ as never, 0, 'normal');

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

async function main(): Promise<void> {
  console.log('=== 共闘でも瞑想はいつ効き始めるか ===');
  console.log(`  瞑想の詠唱: ${瞑想.castTime.toFixed(2)}秒 / 消費MP ${瞑想.manaCost}`);

  const 名 = `fc${Math.random().toString(36).slice(2, 6)}`;
  const 部屋 = await new Client(基点.replace(/^http/, 'ws')).create('coop', {
    name: 名, nickToken: `tok_${名}`, maxStage: 50, stage: 1, charId: 2,
    spells: [
      { name: '瞑想', recipe: 瞑想レシピ, level: 0, rarity: 'normal' },
      { name: '火の魔弾', recipe: { fire: 1 }, level: 0, rarity: 'normal' },
    ],
  });
  const 自分 = () => (部屋.state as any).players?.get(部屋.sessionId);

  try {
    部屋.send('ready', {});
    let 相 = '';
    for (let i = 0; i < 200 && 相 !== 'fight'; i++) {
      await sleep(100);
      相 = (部屋.state as any)?.phase ?? '';
    }
    確認('戦闘が始まった', 相 === 'fight', `phase=${相}`);
    if (相 !== 'fight') return;

    // ★ 押す前から刻んで取る。押してから測り始めると詠唱の頭を取り逃す。
    const 標本: [number, number, number][] = [];   // 経過秒, castT, 上乗せ
    const t0 = Date.now();
    let 撃った = false;
    while (Date.now() - t0 < 3500) {
      const p = 自分();
      if (p) 標本.push([(Date.now() - t0) / 1000, p.castT ?? -1, p.mpRegenBonus ?? 0]);
      if (!撃った && Date.now() - t0 > 400) { 部屋.send('cast', { idx: 0 }); 撃った = true; }
      await sleep(40);
    }

    // castT は詠唱中だけ 0 より大きくなる(完了で 0 に戻る)。
    const 詠唱中 = 標本.filter(r => r[1] > 0);
    const 効いた = 標本.find(r => r[2] > 0);
    確認('詠唱が始まった', 詠唱中.length > 0,
      詠唱中.length ? `${詠唱中[0][0].toFixed(2)}秒の時点から` : '始まっていない');
    確認('瞑想の効果が出た', !!効いた, 効いた ? `${効いた[0].toFixed(2)}秒の時点` : '出ていない');

    if (詠唱中.length > 0 && 効いた) {
      const 開始 = 詠唱中[0][0];
      const 差 = 効いた[0] - 開始;
      console.log(`     詠唱開始 ${開始.toFixed(2)}秒 → 効果 ${効いた[0].toFixed(2)}秒`
        + ` = ${差.toFixed(2)}秒後(詠唱時間は ${瞑想.castTime.toFixed(2)}秒)`);
      // 20Hzのループ + 40ms刻みぶんの誤差を見込む
      確認('効果は詠唱が終わってから出ている', 差 >= 瞑想.castTime - 0.2,
        `${差.toFixed(2)}秒後 / 詠唱${瞑想.castTime.toFixed(2)}秒`);
      const 詠唱中に効いた = 詠唱中.some(r => r[2] > 0);
      確認('詠唱の最中には効いていない', !詠唱中に効いた);
    }
  } finally {
    try { await 部屋.leave(); } catch { /* 済み */ }
    await sleep(400);
  }

  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  await sleep(300);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
