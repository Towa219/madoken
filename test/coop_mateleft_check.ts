// 共闘中に仲間が「退出」を押したあと、残った人が困らないかを確かめる。
//
// 報告: 「共闘中に誰か退出されて復帰できなくなる」
//
// 通信が切れた場合(coop_reconnect_check)とは別の道を通る。
// 退出ボタンは consented な離脱なので、サーバーは復帰を待たずに
// すぐ席を片付ける。そのとき残った人の部屋が壊れていないかを見る。
//
// 見るのは
//   ・仲間が退出しても、残った人の戦闘が続くか(魔法が撃てるか)
//   ・そのあと残った人の通信が切れても、部屋に戻れるか
//   ・自分が復帰待ちの最中に仲間が退出しても、自分は戻れるか
//     (このとき部屋の中は誰も繋がっていない状態になる)
//
//   npx tsx test/coop_mateleft_check.ts

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

// 敵を倒しきらない程度の弱い魔法(ステージが進むと話がややこしくなるため)
const KIT = [{ name: '弱い魔弾', recipe: { water: 2 } }];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'phit', 'shield', 'shieldhit', 'shieldup',
  'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot',
  'quake', 'stageclear', 'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit'];

interface Watch {
  aborted: string;
  result: boolean;
  wait: string;
  back: string;
  mateleft: string;
  left: boolean;
}

function watch(room: Room): Watch {
  const w: Watch = {
    aborted: '', result: false, wait: '', back: '', mateleft: '', left: false,
  };
  room.onMessage('aborted', (m: { name: string }) => { w.aborted = m.name; });
  room.onMessage('result', () => { w.result = true; });
  room.onMessage('pwait', (m: { name: string }) => { w.wait = m.name; });
  room.onMessage('pback', (m: { name: string }) => { w.back = m.name; });
  room.onMessage('mateleft', (m: { name: string }) => { w.mateleft = m.name; });
  room.onLeave(() => { w.left = true; });
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

// 実機の回線断と同じで、こちらから「抜けます」と伝えずに切る
const kill = (room: Room) =>
  (room.connection as unknown as { transport: { ws: { close: (c: number) => void } } })
    .transport.ws.close(4999);

async function startCoop(tag: string) {
  const [a, b] = [`m${tag}A${RUN}`, `m${tag}B${RUN}`];
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
  const started = await waitFor(() => (ra.state as any)?.phase === 'fight', 25_000);
  return { a, b, ca, cb, ra, rb, wa, wb, started };
}

const phaseOf = (r: Room) => String((r.state as any)?.phase ?? '');

// 実際に魔法が通るか(サーバーが受け付けて詠唱に入るか)を見る
async function canCast(r: Room): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    r.send('cast', { idx: 0 });
    await sleep(250);
    const me = (r.state as any)?.players?.get(r.sessionId);
    if (me && me.castingIdx >= 0) return true;
  }
  return false;
}

async function main(): Promise<void> {
  console.log('=== 共闘で仲間が退出したあと ===');
  console.log(`対象: ${ENDPOINT}`);
  const names: string[] = [];

  // ---- 1. 仲間が退出しても、残った人はそのまま戦えて、切れても戻れる ----
  {
    console.log('\n【1】仲間が退出 → 残った人の戦闘と復帰');
    const d = await startCoop('1');
    names.push(d.a, d.b);
    check('共闘が始まった', d.started);

    await d.rb.leave();   // 退出ボタンと同じ(consented)
    check('残った人に「離脱した」と伝わる',
      await waitFor(() => d.wa.mateleft !== '', 10_000), d.wa.mateleft);
    check('残った人のランが終わらされない', d.wa.aborted === '' && !d.wa.result);
    check('残った人は戦闘のまま', phaseOf(d.ra) === 'fight', phaseOf(d.ra));
    check('★残った人はまだ魔法を撃てる', await canCast(d.ra));

    // ここから、残った人の通信が切れたら戻れるか
    const token = d.ra.reconnectionToken;
    kill(d.ra);
    await sleep(3000);
    let backOk = false;
    try {
      const again = await d.ca.reconnect(token);
      watch(again);
      backOk = true;
      await sleep(1200);
      check('★戻ったあとも魔法を撃てる', await canCast(again));
      void again.leave();
    } catch (err) {
      console.log('  (再接続に失敗:', (err as Error).message, ')');
    }
    check('★仲間が退出したあとでも自分は共闘に戻れる', backOk);
    await sleep(1200);
  }

  // ---- 2. 自分が復帰待ちの間に仲間が退出 ----
  // このとき部屋には誰も繋がっていない。部屋ごと消えてしまうと戻れなくなる。
  {
    console.log('\n【2】自分が復帰待ち → その間に仲間が退出');
    const d = await startCoop('2');
    names.push(d.a, d.b);
    check('共闘が始まった', d.started);

    const token = d.rb.reconnectionToken;
    kill(d.rb);                                    // 自分(B)の回線が切れた
    check('仲間に「復帰を待っている」と伝わる',
      await waitFor(() => d.wa.wait !== '', 12_000), d.wa.wait);

    await d.ra.leave();                            // 待ちきれずに仲間(A)が退出
    await sleep(3000);

    let backOk = false;
    let why = '';
    try {
      const again = await d.cb.reconnect(token);
      watch(again);
      backOk = true;
      await sleep(1500);
      check('戻った先はまだ戦闘中', ['fight', 'count'].includes(phaseOf(again)),
        phaseOf(again));
      check('★戻ったあとも魔法を撃てる', await canCast(again));
      void again.leave();
    } catch (err) {
      why = (err as Error).message;
    }
    check('★誰も繋がっていない間も席が残っていて戻れる', backOk, why);
    await sleep(1200);
  }

  for (const n of names) await release(n);
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
