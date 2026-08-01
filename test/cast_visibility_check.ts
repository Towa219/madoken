// 他のプレイヤーの詠唱名と、かかっている効果が見えるかを確認する
// 実行: npx tsx test/cast_visibility_check.ts (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const A = `ca${RUN}`;
const B = `cb${RUN}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let ng = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

// Aは攻撃魔法、Bは全体護盾(聖域系: 土2氷1光1)と全体耐性(万象護符: 水2氷1風1)
const spellsA = [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }];
const spellsB = [
  { name: '地の聖域盾', recipe: { earth: 2, ice: 1, light: 1 } },
  { name: '水の万象護符', recipe: { water: 2, ice: 1, wind: 1 } },
];

async function release(name: string, token: string): Promise<void> {
  try {
    await fetch(`${HTTP_BASE}/api/name/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch { /* 無視 */ }
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
  await sleep(800);

  // Bが全体護盾を詠唱 → Aの画面(=roomAのstate)から名前が見えるか
  let seenCastName = '';
  const watch = setInterval(() => {
    const st: any = roomA.state;
    st?.players?.forEach((p: any) => {
      if (p.name === B && p.castingIdx >= 0 && p.castName) seenCastName = p.castName;
    });
  }, 50);

  roomB.send('cast', { idx: 0 }); // 聖域盾
  await sleep(2500);
  clearInterval(watch);
  check(seenCastName.length > 0,
    `Aの画面にBの詠唱名が見えた: 「${seenCastName || '(見えない)'}」`);

  // 全体護盾なので、A自身にも護盾が付いているはず
  await sleep(800);
  let shieldOnA = 0;
  let shieldOnB = 0;
  (roomA.state as any)?.players?.forEach((p: any) => {
    if (p.name === A) shieldOnA = p.shield;
    if (p.name === B) shieldOnB = p.shield;
  });
  check(shieldOnA > 0 && shieldOnB > 0,
    `全体護盾が2人ともに乗った (A=${shieldOnA} / B=${shieldOnB})`);

  // Bが全体耐性(万象護符)を詠唱 → 2人とも wardPct が立つ
  roomB.send('cast', { idx: 1 });
  await sleep(3000);
  let wardA = 0;
  let wardB = 0;
  (roomA.state as any)?.players?.forEach((p: any) => {
    if (p.name === A) wardA = p.wardPct;
    if (p.name === B) wardB = p.wardPct;
  });
  check(wardA > 0 && wardB > 0,
    `全体耐性が2人ともに乗り、他人の分も見える (A=${wardA}% / B=${wardB}%)`);

  void roomA.leave();
  void roomB.leave();
  await release(A, `tk${RUN}a`);
  await release(B, `tk${RUN}b`);

  console.log(ng === 0 ? '=== 表示の共有 合格 ===' : `=== ${ng}件の不具合 ===`);
  setTimeout(() => process.exit(ng === 0 ? 0 : 1), 800);
}

void main();
