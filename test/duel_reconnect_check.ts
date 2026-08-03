// 決闘中に通信が切れても、戻ってこられるかを確かめる。
//
// 「決闘が途中で落ちる」の正体はこれだった。再接続の仕組みが無く、
// Colyseusの既定値では約6秒(ping3秒×2回)無応答なだけでサーバーが切断し、
// 決闘はその場で終了していた。スマホの画面を消した、電波が一瞬途切れた、
// PCがスリープしかけた——それだけで落ちる。
//
// 見るのは
//   ・切れた側が席を取り戻せるか(相手の勝ちにされていないか)
//   ・待っている間、時間が止まっているか(切れた側が殴られ放題にならないか)
//   ・戻ってこなければ、ちゃんと残った側の勝ちになるか
//
//   npx tsx test/duel_reconnect_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { RECONNECT_SEC } from '../shared/data';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(120);
  }
  return false;
}

const KIT = [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }];

const QUIET = ['dproj', 'dhit', 'dshield', 'dheal', 'dguard', 'dseal', 'dfocus',
  'dempower', 'dward', 'dwardhit', 'dvigor', 'ddot', 'replaced'];

interface Watch {
  end: { win: boolean; reason?: string } | null;
  waited: string;
  back: string;
}

function watch(room: Room): Watch {
  const w: Watch = { end: null, waited: '', back: '' };
  room.onMessage('duelend', (m: { win: boolean; reason?: string }) => { w.end = m; });
  room.onMessage('dwait', (m: { name: string }) => { w.waited = m.name; });
  room.onMessage('dback', (m: { name: string }) => { w.back = m.name; });
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

// 決闘を1つ立ち上げ、fight まで進める
async function startDuel(tag: string) {
  const [a, b] = [`x${tag}A${RUN}`, `x${tag}B${RUN}`];
  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);
  const ra: Room = await ca.joinOrCreate('duel',
    { name: a, spells: KIT, nickToken: `tokx${tag}A${RUN}`, charId: 0 });
  const rb: Room = await cb.joinOrCreate('duel',
    { name: b, spells: KIT, nickToken: `tokx${tag}B${RUN}`, charId: 1 });
  const wa = watch(ra);
  const wb = watch(rb);
  await waitFor(() => (ra.state as any)?.players?.size === 2);
  ra.send('ready');
  rb.send('ready');
  const started = await waitFor(() => (ra.state as any)?.phase === 'fight', 20_000);
  return { a, b, ca, cb, ra, rb, wa, wb, started };
}

async function main(): Promise<void> {
  console.log('=== 決闘の再接続の検証 ===');
  console.log(`対象: ${ENDPOINT}`);
  const names: string[] = [];

  // ---- 1. 切れた側が戻ってこられる ----
  {
    const d = await startDuel('1');
    names.push(d.a, d.b);
    check('決闘が開始した', d.started);

    const token = d.rb.reconnectionToken;
    const hpBefore = Number((d.ra.state as any)?.players?.get(d.rb.sessionId)?.hp ?? 0);

    // 相手の意思とは無関係に、通信だけを切る
    (d.rb.connection as unknown as { transport: { ws: { close: (c: number) => void } } })
      .transport.ws.close(4999);

    check('残った側に「復帰を待っている」と伝わる',
      await waitFor(() => d.wa.waited !== '', 12_000), d.wa.waited);
    check('この時点で決着にされていない', d.wa.end === null,
      d.wa.end ? JSON.stringify(d.wa.end) : '');

    // 待っている間は時間が止まっているか(殴られ放題にならないか)
    d.ra.send('cast', { idx: 0 });
    await sleep(4000);
    const hpDuring = Number((d.ra.state as any)?.players?.get(d.rb.sessionId)?.hp ?? 0);
    check('待っている間はHPが減らない(時間が止まっている)', hpDuring === hpBefore,
      `${hpBefore} → ${hpDuring}`);

    // 戻る
    let backOk = false;
    try {
      const again = await d.cb.reconnect(token);
      watch(again);
      backOk = true;
      await sleep(1500);
    } catch (err) {
      console.log('  (再接続に失敗:', (err as Error).message, ')');
    }
    check('切れた側が決闘に戻れた', backOk);
    check('残った側に「戻ってきた」と伝わる',
      await waitFor(() => d.wa.back !== '', 8000), d.wa.back);
    check('決闘は終わっていない', d.wa.end === null,
      d.wa.end ? JSON.stringify(d.wa.end) : '');

    try { void d.ra.leave(); } catch { /* 切断済み */ }
    await sleep(1200);
  }

  // ---- 2. 戻ってこなければ、残った側の勝ち ----
  {
    const d = await startDuel('2');
    names.push(d.a, d.b);
    check('2戦目も開始した', d.started);

    (d.rb.connection as unknown as { transport: { ws: { close: (c: number) => void } } })
      .transport.ws.close(4999);
    check('復帰待ちに入った', await waitFor(() => d.wa.waited !== '', 12_000));

    // 30秒待たずに、はっきり棄権した場合はすぐ決着してよい
    console.log(`     (復帰せずに${RECONNECT_SEC}秒待つ…)`);
    check('戻らなければ残った側の勝ちになる',
      await waitFor(() => d.wa.end !== null, (RECONNECT_SEC + 20) * 1000),
      d.wa.end?.reason ?? '決着しなかった');

    try { void d.ra.leave(); } catch { /* 切断済み */ }
    await sleep(1200);
  }

  for (const n of names) await release(n);
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 800);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
