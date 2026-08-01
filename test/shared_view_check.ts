// 共闘で「全員が同じ情報を見られるか」を確認する。
// Bがかけた効果・Bの詠唱・敵の状態異常が、Aの画面(=Aが受け取るstate)に出るかを見る。

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const A = `sa${RUN}`;
const B = `sb${RUN}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let ng = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

// A: 継続ダメージ(腐蝕: 闇2水1)と凍結(氷2水1)
// B: 全体護盾(聖域: 土2氷1光1)・全体耐性(万象護符: 水2氷1風1)・全体攻撃上昇(戦鼓: 火2雷1風1)
const spellsA = [
  { name: '腐蝕弾', recipe: { dark: 2, water: 1 } },
  { name: '凍結槍', recipe: { ice: 2, water: 1 } },
];
const spellsB = [
  { name: '聖域盾', recipe: { earth: 2, ice: 1, light: 1 } },
  { name: '万象護符', recipe: { water: 2, ice: 1, wind: 1 } },
  { name: '戦鼓', recipe: { fire: 2, thunder: 1, wind: 1 } },
];

async function release(name: string, token: string): Promise<void> {
  try {
    await fetch(`${HTTP_BASE}/api/name/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch { /* 無視 */ }
}

// Aのstateから値を拾う(=Aの画面に出せる情報)
function playerOf(room: Room, name: string): any {
  let found: any = null;
  (room.state as any)?.players?.forEach((p: any) => { if (p.name === name) found = p; });
  return found;
}

async function main(): Promise<void> {
  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);

  const roomA: Room = await ca.create('coop', {
    name: A, spells: spellsA, stage: 1, maxStage: 1, nickToken: `tk${RUN}a`,
  });
  await sleep(300);
  const roomB: Room = await cb.joinById(roomA.roomId, {
    name: B, spells: spellsB, maxStage: 1, nickToken: `tk${RUN}b`,
  });
  await sleep(300);
  roomA.send('ready');
  roomB.send('ready');
  await sleep(900);

  // --- Bの詠唱名がAに見えるか(監視しながら) ---
  let sawCast = '';
  const watch = setInterval(() => {
    const b = playerOf(roomA, B);
    if (b?.castingIdx >= 0 && b.castName) sawCast = b.castName;
  }, 40);

  roomB.send('cast', { idx: 0 });            // 全体護盾
  await sleep(2600);
  check(sawCast !== '', `Bの詠唱名がAに見える: 「${sawCast || '見えない'}」`);
  check((playerOf(roomA, A)?.shield ?? 0) > 0 && (playerOf(roomA, B)?.shield ?? 0) > 0,
    `全体護盾が2人に乗り、Aから両方見える (A=${playerOf(roomA, A)?.shield} / B=${playerOf(roomA, B)?.shield})`);

  roomB.send('cast', { idx: 1 });            // 全体耐性
  await sleep(3000);
  check((playerOf(roomA, A)?.wardPct ?? 0) > 0 && (playerOf(roomA, B)?.wardPct ?? 0) > 0,
    `全体耐性が2人に乗り、Aから両方見える (A=${playerOf(roomA, A)?.wardPct}% / B=${playerOf(roomA, B)?.wardPct}%)`);

  roomB.send('cast', { idx: 2 });            // 全体攻撃上昇
  await sleep(3000);
  check((playerOf(roomA, A)?.atkBoost ?? 0) > 0 && (playerOf(roomA, B)?.atkBoost ?? 0) > 0,
    `全体攻撃上昇が2人に乗り、Aから両方見える (A=${playerOf(roomA, A)?.atkBoost}% / B=${playerOf(roomA, B)?.atkBoost}%)`);
  clearInterval(watch);

  // --- 仲間のMPが見えるか(数値が同期されているか) ---
  const bMp = playerOf(roomA, B)?.mp;
  const bMaxMp = playerOf(roomA, B)?.maxMp;
  check(typeof bMp === 'number' && typeof bMaxMp === 'number' && bMp < bMaxMp,
    `仲間のMPがAから見える (B: ${bMp}/${bMaxMp})`);

  // --- Aがかけた敵の状態異常が、Bの画面にも出るか ---
  let sawBurning = false;
  let sawFrozenOrSlow = false;
  const watch2 = setInterval(() => {
    (roomB.state as any)?.enemies?.forEach((e: any) => {
      if (e.burning) sawBurning = true;
      if (e.frozen || e.slowed) sawFrozenOrSlow = true;
    });
  }, 40);
  roomA.send('cast', { idx: 0 }); // 腐蝕(継続ダメージ)
  await sleep(3000);
  roomA.send('cast', { idx: 1 }); // 凍結(詠唱+弾の到達で4秒ほどかかる)
  await sleep(5500);
  clearInterval(watch2);
  check(sawBurning, 'Aがかけた継続ダメージの状態がBの画面にも出る');
  check(sawFrozenOrSlow, 'Aがかけた凍結/鈍化の状態がBの画面にも出る');

  void roomA.leave();
  void roomB.leave();
  await release(A, `tk${RUN}a`);
  await release(B, `tk${RUN}b`);

  console.log(ng === 0 ? '=== 情報の共有 合格 ===' : `=== ${ng}件の不具合 ===`);
  setTimeout(() => process.exit(ng === 0 ? 0 : 1), 800);
}

void main();
