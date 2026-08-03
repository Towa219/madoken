// 共闘中に通信が切れても、戻ってこられるかを確かめる。
//
// 「共闘で通信が切れたためと出てメンバーが落ちる」の正体はこれだった。
// 再接続の仕組みが無いうえ、サーバーは戦闘中に1人でも離脱すると abortRun で
// 部屋にいる全員のランを強制終了していた。つまり1人の電波が一瞬途切れただけで、
// 一緒に戦っていた全員が巻き添えで終わっていた。
//
// 見るのは
//   ・切れた人が席を取り戻せるか
//   ・その間、残った人のランが終わらされないか(ここが本題)
//   ・待っている間、切れた人が敵に狙われないか(操作できないのに殴られるのは酷)
//   ・戻ってこなければ、従来どおり中断として扱われるか
//
//   npx tsx test/coop_reconnect_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

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

const KIT = [{ name: '弱い魔弾', recipe: { water: 2 } }];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'shield', 'heal', 'taunt', 'ward',
  'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot', 'quake', 'stageclear',
  'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit'];

interface Watch {
  aborted: { name: string } | null;
  ended: boolean;
  wait: string;
  back: string;
}

function watch(room: Room): Watch {
  const w: Watch = { aborted: null, ended: false, wait: '', back: '' };
  room.onMessage('aborted', (m: { name: string }) => { w.aborted = m; });
  room.onMessage('coopend', () => { w.ended = true; });
  room.onMessage('pwait', (m: { name: string }) => { w.wait = m.name; });
  room.onMessage('pback', (m: { name: string }) => { w.back = m.name; });
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

// 2人で通常ステージの共闘を始める
async function startCoop(tag: string) {
  const [a, b] = [`k${tag}A${RUN}`, `k${tag}B${RUN}`];
  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);
  const ra: Room = await ca.create('coop', {
    name: a, spells: KIT, stage: 1, maxStage: 1, nickToken: `tok${a}`,
  });
  await sleep(400);
  const rb: Room = await cb.joinById(ra.roomId, {
    name: b, spells: KIT, maxStage: 1, nickToken: `tok${b}`,
  });
  const wa = watch(ra);
  const wb = watch(rb);
  await waitFor(() => (ra.state as any)?.players?.size === 2, 15_000);
  ra.send('ready');
  rb.send('ready');
  const started = await waitFor(() => (ra.state as any)?.phase === 'fight', 20_000);
  return { a, b, ca, cb, ra, rb, wa, wb, started };
}

async function main(): Promise<void> {
  console.log('=== 共闘の再接続の検証 ===');
  console.log(`対象: ${ENDPOINT}`);
  const names: string[] = [];

  // ---- 1. 切れた人が戻ってこられる。残った人は巻き添えにならない ----
  {
    const d = await startCoop('1');
    names.push(d.a, d.b);
    check('共闘が始まった', d.started);

    const token = d.rb.reconnectionToken;
    const sidB = d.rb.sessionId;
    const hpBefore = Number((d.ra.state as any)?.players?.get(sidB)?.hp ?? 0);

    kill(d.rb);

    check('残った人に「復帰を待っている」と伝わる',
      await waitFor(() => d.wa.wait !== '', 12_000), d.wa.wait);
    check('★残った人のランが終わらされない', d.wa.aborted === null,
      d.wa.aborted ? `中断された(${(d.wa.aborted as { name: string }).name})` : '');

    // 待っている間、操作できない人は狙われない
    await sleep(6000);
    const hpDuring = Number((d.ra.state as any)?.players?.get(sidB)?.hp ?? 0);
    check('待っている間は狙われない', hpDuring === hpBefore, `${hpBefore} → ${hpDuring}`);
    check('この時点でもまだ中断されていない', d.wa.aborted === null);

    let backOk = false;
    try {
      const again = await d.cb.reconnect(token);
      watch(again);
      backOk = true;
      await sleep(1500);
    } catch (err) {
      console.log('  (再接続に失敗:', (err as Error).message, ')');
    }
    check('切れた人が共闘に戻れた', backOk);
    check('残った人に「戻ってきた」と伝わる',
      await waitFor(() => d.wa.back !== '', 8000), d.wa.back);
    check('最後まで中断されなかった', d.wa.aborted === null);

    try { void d.ra.leave(); } catch { /* 切断済み */ }
    await sleep(1500);
  }

  // ---- 2. 戻ってこなければ、従来どおり中断として扱う ----
  {
    const d = await startCoop('2');
    names.push(d.a, d.b);
    check('2回目も始まった', d.started);

    kill(d.rb);
    check('復帰待ちに入った', await waitFor(() => d.wa.wait !== '', 12_000));
    console.log('     (復帰せずに30秒待つ…)');
    check('戻らなければ中断になる',
      await waitFor(() => d.wa.aborted !== null, 45_000),
      d.wa.aborted ? `${(d.wa.aborted as { name: string }).name} が離脱` : '中断されなかった');

    try { void d.ra.leave(); } catch { /* 切断済み */ }
    await sleep(1200);
  }

  for (const n of names) await release(n);
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
