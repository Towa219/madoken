// ボスの全体攻撃が働くかを確かめる。
//
// これまで敵の攻撃は必ず1人だけを狙っていたので、挑発役が引き受ければ
// 他の人は無傷でいられ、回復・護符・全体護盾を持つ意味がほとんど無かった。
// ボスは何回かに一度、狙いを定めず全員を巻き込む一撃を放つ。
//
// 見るのは
//   ・予告(eaoewarn)が来てから、間を置いて着弾(eaoehit)すること
//     予告なしに全員が削られると理不尽なので、必ず間がなければならない
//   ・着弾で「その場にいる全員」のHPが減ること(1人だけではない)
//   ・全体攻撃の一撃が通常攻撃より重いこと
//   ・通常の敵(ボス以外)は全体攻撃をしないこと
//
//   npx tsx test/boss_aoe_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { BOSSES, BOSS_AOE_WARN_SEC, ENEMIES } from '../shared/data';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(80);
  }
  return false;
}

// 弱い魔法だけ持たせる。すぐ倒してしまうと全体攻撃が来る前に終わる。
const KIT = [{ name: '弱い魔弾', recipe: { water: 2 } }];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'shield', 'heal', 'taunt', 'ward',
  'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot', 'quake', 'stageclear',
  'coopend', 'replaced', 'down', 'revive'];

interface Watch {
  warns: { at: number; name: string }[];
  hits: { at: number }[];
}

function watch(room: Room): Watch {
  const w: Watch = { warns: [], hits: [] };
  room.onMessage('eaoewarn', (m: { name: string }) => {
    w.warns.push({ at: Date.now(), name: m.name });
  });
  room.onMessage('eaoehit', () => { w.hits.push({ at: Date.now() }); });
  for (const t of QUIET) room.onMessage(t, () => { /* 表示用 */ });
  return w;
}

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
  console.log('=== ボスの全体攻撃の検証 ===');
  console.log(`対象: ${ENDPOINT}`);

  // ---- 0. 設定 ----
  const noAoe = BOSSES.filter(b => !b.aoeEvery);
  check('全ボスが全体攻撃を持つ', noAoe.length === 0,
    noAoe.map(b => b.name).join('・') || `${BOSSES.length}体すべて`);
  const weak = BOSSES.filter(b => (b.aoeMul ?? 0) <= 1);
  check('全体攻撃は通常攻撃より重い', weak.length === 0,
    weak.map(b => b.name).join('・') || '全ボスで1倍超');
  // 後半のボスほど重く、頻度も上がる
  const first = BOSSES[0];
  const last = BOSSES[BOSSES.length - 1];
  check('後のボスほど一撃が重い', (last.aoeMul ?? 0) > (first.aoeMul ?? 0),
    `${first.name}×${first.aoeMul} → ${last.name}×${last.aoeMul}`);
  check('後のボスほど頻度が高い', (last.aoeEvery ?? 99) <= (first.aoeEvery ?? 0),
    `${first.name}は${first.aoeEvery}回に1回 → ${last.name}は${last.aoeEvery}回に1回`);
  const normalAoe = ENEMIES.filter(e => e.aoeEvery);
  check('通常の敵は全体攻撃をしない', normalAoe.length === 0,
    normalAoe.map(e => e.name).join('・') || `${ENEMIES.length}体すべて単体`);

  // ---- 1. 実際のボス戦 ----
  const names = [`bA${RUN}`, `bB${RUN}`];
  const rooms: Room[] = [];
  const ws: Watch[] = [];
  try {
    const ca = new Client(ENDPOINT);
    const cb = new Client(ENDPOINT);
    const ra: Room = await ca.create('coop', {
      name: names[0], spells: KIT, stage: 5, maxStage: 5, nickToken: `tok${names[0]}`,
    });
    rooms.push(ra); ws.push(watch(ra));
    await sleep(400);
    const rb: Room = await cb.joinById(ra.roomId, {
      name: names[1], spells: KIT, maxStage: 5, nickToken: `tok${names[1]}`,
    });
    rooms.push(rb); ws.push(watch(rb));

    check('ボス部屋に2人入った',
      await waitFor(() => (ra.state as any)?.players?.size === 2, 15_000));

    ra.send('ready');
    rb.send('ready');
    check('ボス戦が始まった',
      await waitFor(() => (ra.state as any)?.phase === 'fight', 20_000));

    const boss = (ra.state as any)?.enemies?.[0];
    console.log(`     ボス: ${boss?.name}`);

    // 一切攻撃しないで待つ。全体攻撃が来るのを見るだけ。
    const gotWarn = await waitFor(() => ws[0].warns.length > 0, 60_000);
    check('全体攻撃の予告が来た', gotWarn,
      gotWarn ? ws[0].warns[0].name : '60秒待っても来なかった');
    if (!gotWarn) return;

    // 予告の瞬間のHPを控える
    const hpAt = () => {
      const out: Record<string, number> = {};
      (ra.state as any).players.forEach((p: any, sid: string) => { out[sid] = p.hp; });
      return out;
    };
    const before = hpAt();

    const gotHit = await waitFor(() => ws[0].hits.length > 0, 15_000);
    check('予告のあとに着弾した', gotHit);
    if (!gotHit) return;

    const gap = (ws[0].hits[0].at - ws[0].warns[0].at) / 1000;
    check(`予告から着弾まで間がある(${BOSS_AOE_WARN_SEC}秒の想定)`,
      gap >= BOSS_AOE_WARN_SEC * 0.7, `${gap.toFixed(2)}秒`);

    await sleep(500);
    const after = hpAt();
    const dropped = Object.keys(before).filter(sid => after[sid] < before[sid]);
    check('その場の全員のHPが減った', dropped.length === Object.keys(before).length,
      `${dropped.length}人 / ${Object.keys(before).length}人`);

    const dmgs = Object.keys(before).map(sid => before[sid] - after[sid]);
    console.log(`     受けたダメージ: ${dmgs.join(' / ')}`);
    check('全員が同じ一撃を受けた(差はゆらぎの範囲)',
      Math.max(...dmgs) - Math.min(...dmgs) <= 2, dmgs.join(' / '));

    // 予告も着弾も両方の画面に届いているか
    check('もう一方の画面にも予告が届いた', ws[1].warns.length > 0, `${ws[1].warns.length}回`);
    check('もう一方の画面にも着弾が届いた', ws[1].hits.length > 0, `${ws[1].hits.length}回`);
  } finally {
    for (const r of rooms) { try { void r.leave(); } catch { /* 切断済み */ } }
    await sleep(800);
    for (const n of names) await release(n);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
