// ボスを封印している間は全体攻撃が来ないことを確かめる。
//
// 封印中のボスはそもそも殴ってこない。抜け道は「予告してから着弾するまでの
// 1.8秒」だけで、ここを塞いでいなかった。予告を見てから封印しても
// 全体攻撃だけは飛んでくるので、封印を持ち込んだ意味が薄かった。
//
// 見るのは
//   ・予告(eaoewarn)を見てから封印すると、着弾(eaoehit)が来ないか
//   ・代わりに「止めた」(eaoestop)が来るか
//   ・封印していない時はちゃんと着弾するか(止めすぎていないか)
//
//   npx tsx test/seal_stops_aoe_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const STAGE = 5;   // ボス「魔導核」。闇が弱点なので封印がレジストされない

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 25_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
}

// 0番=封印(闇のみで作ると seal になる)、1番=ボスを削らない弱い一撃。
// ボスを倒してしまうと全体攻撃の周期まで届かないので、火力は出さない。
const KIT = [
  { name: '闇の封印', recipe: { dark: 3 }, level: 0, rarity: 'normal' },
  { name: '弱い魔弾', recipe: { water: 2 }, level: 0, rarity: 'normal' },
];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'phit', 'shield', 'shieldhit', 'shieldup',
  'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'dot',
  'quake', 'stageclear', 'replaced', 'down', 'revive', 'result', 'aborted',
  'pwait', 'pback', 'mateleft'];

async function release(name: string): Promise<void> {
  try {
    await fetch(`${HTTP}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: `tok${name}` }),
    });
  } catch { /* 消せなくてもテストの成否には関係ない */ }
}

async function main(): Promise<void> {
  console.log('=== 封印中は全体攻撃が来ない ===');
  console.log(`対象: ${ENDPOINT} / ステージ${STAGE}(ボス)`);
  const name = `sz${RUN}`;

  const c = new Client(ENDPOINT);
  let room: Room | null = null;
  try {
    room = await c.create('coop', {
      name, spells: KIT, stage: STAGE, maxStage: STAGE, nickToken: `tok${name}`,
    });
    const r = room;

    let warns = 0;
    let hits = 0;
    let stops = 0;
    let sealedSec = 0;
    r.onMessage('eaoewarn', () => { warns++; });
    r.onMessage('eaoehit', () => { hits++; });
    r.onMessage('eaoestop', () => { stops++; });
    r.onMessage('seal', (m: { sec: number }) => { sealedSec = Number(m.sec) || 0; });
    for (const t of QUIET) r.onMessage(t, () => { /* 表示用 */ });

    await waitFor(() => String((r.state as any)?.phase) === 'ready', 15_000);
    r.send('ready');
    check('ボス戦が始まった',
      await waitFor(() => String((r.state as any)?.phase) === 'fight', 25_000));

    // ---- 1. 封印しないでいると、全体攻撃はちゃんと当たる ----
    console.log('     (封印せずに全体攻撃を待つ…)');
    const gotWarn1 = await waitFor(() => warns >= 1, 60_000);
    check('全体攻撃の予告が来た', gotWarn1);
    check('★封印していなければ着弾する', await waitFor(() => hits >= 1, 12_000),
      `予告${warns}回 / 着弾${hits}回`);

    // ---- 2. 予告を見てから封印すると止まる ----
    console.log('     (次の予告を待って、そこから封印する…)');
    const warnsBefore = warns;
    const hitsBefore = hits;
    const gotWarn2 = await waitFor(() => warns > warnsBefore, 90_000);
    check('2回目の予告が来た', gotWarn2);

    // 予告を見た瞬間に封印を投げる(詠唱ぶん遅れても着弾までには間に合う)
    for (let i = 0; i < 20 && sealedSec === 0; i++) {
      r.send('cast', { idx: 0 });
      await sleep(150);
    }
    check('封印が効いた(レジストされていない)', sealedSec > 0, `${sealedSec.toFixed(1)}秒`);

    await sleep(3500);   // 予告1.8秒ぶんを十分に越えて待つ
    check('★封印しているあいだは全体攻撃が来ない', hits === hitsBefore,
      hits === hitsBefore ? '' : `着弾してしまった(${hits - hitsBefore}回)`);
    check('★「止めた」が知らされる', stops >= 1, `${stops}回`);
  } finally {
    try { void room?.leave(); } catch { /* 切断済み */ }
    await sleep(800);
    await release(name);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
