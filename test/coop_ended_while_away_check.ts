// 自分が復帰待ちの間に共闘が終わってしまった時、戻ってきて何が起きるかを確かめる。
//
// 報告: 「共闘中に誰か退出されて復帰できなくなる」
//
// 決着(result)と中断(aborted)の知らせは、その時つながっている人にしか届かない。
// 倒れたあとに通信が切れ、そのあいだに仲間が退出して戦闘が終わると、
// 戻ってきた人には何の知らせも来ない。画面は戦闘のままで魔法ボタンは
// すべて灰色。退出を押す以外に何もできない=「復帰できない」。
//
// 見るのは
//   ・戻ってきた人に、留守中の決着がちゃんと伝わるか
//
//   npx tsx test/coop_ended_while_away_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const STAGE = 24;   // 敵が強く、weakなキットではまず倒れるステージ(ボスではない)

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
    await sleep(100);
  }
  return false;
}

// 敵をまず倒せない魔法。倒れるまで待ちたいので弱いままにする。
const KIT = [{ name: '弱い魔弾', recipe: { water: 2 } }];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'phit', 'shield', 'shieldhit', 'shieldup',
  'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot',
  'quake', 'stageclear', 'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit',
  'pwait', 'pback', 'mateleft'];

interface Watch { result: string; aborted: string; }

function watch(room: Room): Watch {
  const w: Watch = { result: '', aborted: '' };
  room.onMessage('result', (m: { win: boolean }) => { w.result = m.win ? '勝利' : '全滅'; });
  room.onMessage('aborted', (m: { name: string }) => { w.aborted = m.name || '中断'; });
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

const kill = (room: Room) =>
  (room.connection as unknown as { transport: { ws: { close: (c: number) => void } } })
    .transport.ws.close(4999);

const aliveOf = (r: Room, sid: string) =>
  Boolean((r.state as any)?.players?.get(sid)?.alive);

// ---- 2. 全員が同時に切れている一瞬にステージ移行が来た場合 ----
//
// クリア後は4秒おいて次のステージへ進む。その4秒のあいだに通信が切れると、
// 移行の判断が「今つながっている人数」を見ていたために消えてしまい、
// 部屋はクリア表示のまま永久に止まる。戻ってきても敵はいない・ボタンは灰色。
async function stageChangeWhileAway(): Promise<void> {
  console.log('\n【2】ステージ移行の瞬間に通信が切れた場合');
  const name = `sA${RUN}`;
  const c = new Client(ENDPOINT);
  const r: Room = await c.create('coop', {
    // ステージ1を一撃で片付けられる装備。移行の瞬間を狙いたいので手早く終わらせる
    name, stage: 1, maxStage: 1, nickToken: `tok${name}`,
    spells: [{
      name: '強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 },
      level: 9, rarity: 'legend',
    }],
  });
  watch(r);
  await waitFor(() => (r.state as any)?.phase === 'ready', 15_000);
  r.send('ready');
  check('共闘が始まった', await waitFor(() => (r.state as any)?.phase === 'fight', 25_000));

  const caster = setInterval(() => {
    const me = (r.state as any)?.players?.get(r.sessionId);
    if ((r.state as any)?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
      r.send('cast', { idx: 0 });
    }
  }, 300);
  const cleared = await waitFor(() => String((r.state as any)?.phase) === 'clear', 90_000);
  clearInterval(caster);
  check('ステージ1をクリアした', cleared);

  const token = r.reconnectionToken;
  kill(r);                       // クリア直後(次ステージへ移る前)に切れる
  console.log('     (移行を待つ4秒のあいだ、誰も繋がっていない状態にする…)');
  await sleep(8000);

  let again: Room | null = null;
  let why = '';
  try { again = await c.reconnect(token); } catch (err) { why = (err as Error).message; }
  check('部屋に戻れた', again !== null, why);
  if (!again) { await release(name); return; }
  watch(again);
  await sleep(2500);

  const phase = String((again.state as any)?.phase ?? '');
  const stage = Number((again.state as any)?.stage ?? 0);
  check('★次のステージへちゃんと進んでいる(クリア表示のまま止まらない)',
    stage >= 2 && ['count', 'fight'].includes(phase), `ステージ${stage} / ${phase}`);

  try { void again.leave(); } catch { /* 切断済み */ }
  await sleep(800);
  await release(name);
}

async function endedWhileAway(): Promise<void> {
  console.log('\n【1】倒れたまま通信が切れ、その間に仲間が退出');
  const [a, b] = [`eA${RUN}`, `eB${RUN}`];
  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);
  const ra: Room = await ca.create('coop', {
    name: a, spells: KIT, stage: STAGE, maxStage: STAGE, nickToken: `tok${a}`,
  });
  await sleep(400);
  const rb: Room = await cb.joinById(ra.roomId, {
    name: b, spells: KIT, maxStage: STAGE, nickToken: `tok${b}`,
  });
  watch(ra);
  watch(rb);
  await waitFor(() => (ra.state as any)?.players?.size === 2, 15_000);
  ra.send('ready');
  rb.send('ready');
  check('共闘が始まった',
    await waitFor(() => (ra.state as any)?.phase === 'fight', 25_000));
  console.log(`     (ステージ${STAGE})`);

  const sidA = ra.sessionId;
  const sidB = rb.sessionId;

  // どちらかが倒れるまで待つ(倒れた方を「留守にする人」にする)
  console.log('     (どちらかが倒れるまで待つ…)');
  const someoneDown = await waitFor(
    () => !aliveOf(ra, sidA) || !aliveOf(ra, sidB), 120_000);
  check('片方が倒れた', someoneDown);
  if (!someoneDown) { for (const n of [a, b]) await release(n); return; }

  const downIsA = !aliveOf(ra, sidA);
  const down = downIsA ? { room: ra, client: ca, name: a } : { room: rb, client: cb, name: b };
  const other = downIsA ? { room: rb, name: b } : { room: ra, name: a };
  console.log(`     倒れたのは ${down.name}`);

  // 倒れた人の通信が切れる
  const token = down.room.reconnectionToken;
  kill(down.room);
  await sleep(2500);

  // 残った人が「退出」を押す → 部屋には倒れた人しか残らず、そこで全滅が確定する
  await other.room.leave();
  console.log(`     ${other.name} が退出した`);
  await sleep(3000);

  // 倒れた人が戻ってくる
  let again: Room | null = null;
  let why = '';
  try {
    again = await down.client.reconnect(token);
  } catch (err) { why = (err as Error).message; }
  check('倒れた人が部屋に戻れた', again !== null, why);
  if (!again) { for (const n of [a, b]) await release(n); return; }

  const w = watch(again);
  // 本物の画面(coop.ts の wireRoom)が復帰したときに投げるのと同じ問い合わせ。
  // 受け取り口を用意してから聞く、という順番までそろえてある。
  again.send('catchup');
  await sleep(4000);

  const phase = String((again.state as any)?.phase ?? '');
  console.log(`     戻った先の状態: phase=${phase}`);
  check('★留守中の決着が戻ってきた人にも伝わる',
    w.result !== '' || w.aborted !== '',
    w.result || w.aborted || '何の知らせも来ない(画面が固まる)');

  try { void again.leave(); } catch { /* 切断済み */ }
  await sleep(800);
  for (const n of [a, b]) await release(n);
}

async function main(): Promise<void> {
  console.log('=== 留守中に共闘が進んでいた場合 ===');
  console.log(`対象: ${ENDPOINT}`);
  await endedWhileAway();
  await stageChangeWhileAway();
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
