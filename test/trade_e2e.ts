// E2E: 実サーバーのロビーに2人で入り、個人取引を成立させるまでを通しで見る
//   npx tsx test/trade_e2e.ts   (サーバー起動済みであること)
//
// test/trade_check.ts が卓の決まりごとを直接呼んで確かめるのに対し、
// こちらは配線を見る ― ロビー部屋がメッセージを卓へ渡し、卓の返事が
// 相手のクライアントまで届くか。単体の検証は通るのに繋ぎ忘れている、
// という壊れ方はここでしか捕まらない。

import { Client } from 'colyseus.js';
import { countsValue, RARE_VALUE } from '../shared/trade';
import type { Room } from 'colyseus.js';
import type { ElementCounts } from '../shared/types';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');

// 実行ごとに別名を使い、終わったら解放する(登録簿を汚さない)
const RUN = Math.random().toString(36).slice(2, 7);
const NAME_A = `tA${RUN}`;
const NAME_B = `tB${RUN}`;
const TOKEN_A = `tok${RUN}A`;
const TOKEN_B = `tok${RUN}B`;

let ng = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) { check(`${what}(待ち)`, false, 'タイムアウト'); return false; }
    await sleep(80);
  }
  return true;
}

async function releaseNames(): Promise<void> {
  for (const [name, token] of [[NAME_A, TOKEN_A], [NAME_B, TOKEN_B]]) {
    try {
      await fetch(`${HTTP_BASE}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token }),
      });
    } catch { /* 解放できなくても結果には影響しない */ }
  }
}

// 届いたメッセージを型ごとに控える
interface Seen {
  invited?: { name: string };
  begin?: { peer: string; name: string };
  view?: { mine: ElementCounts; theirs: ElementCounts; myReady: boolean; theirReady: boolean };
  done?: { give: ElementCounts; get: ElementCounts };
  closed?: { text: string };
  error?: { text: string };
  declined?: { name: string };
}

function watch(room: Room): Seen {
  const seen: Seen = {};
  room.onMessage('trade:invited', (m: Seen['invited']) => { seen.invited = m; });
  room.onMessage('trade:begin', (m: Seen['begin']) => { seen.begin = m; });
  room.onMessage('trade:view', (m: Seen['view']) => { seen.view = m; });
  room.onMessage('trade:done', (m: Seen['done']) => { seen.done = m; });
  room.onMessage('trade:closed', (m: Seen['closed']) => { seen.closed = m; });
  room.onMessage('trade:error', (m: Seen['error']) => { seen.error = m; });
  room.onMessage('trade:declined', (m: Seen['declined']) => { seen.declined = m; });
  room.onMessage('trade:sent', () => { /* 控えだけ。見張らない */ });
  room.onMessage('trade:cancelInvite', () => { /* 同上 */ });
  room.onMessage('chat', () => { /* 入退室の知らせ */ });
  room.onMessage('replaced', () => { /* 使わない */ });
  return seen;
}

async function main(): Promise<void> {
  console.log('=== 個人取引 E2E(実サーバー) ===');
  console.log(`対象: ${ENDPOINT}`);

  const client = new Client(ENDPOINT);
  let a: Room | null = null;
  let b: Room | null = null;

  try {
    a = await client.joinOrCreate('lobby_chat', { name: NAME_A, nickToken: TOKEN_A });
    b = await client.joinOrCreate('lobby_chat', { name: NAME_B, nickToken: TOKEN_B });
    const seenA = watch(a);
    const seenB = watch(b);
    check('二人ともロビーに入れた', Boolean(a && b));

    // 相手のsessionIdは在室者リスト(MapSchemaのキー)から引く
    await waitFor(() => {
      const st = a!.state as { players?: { size?: number } };
      return (st.players?.size ?? 0) >= 2;
    }, '在室者リストに二人ぶん載る');
    const idB = b.sessionId;

    // ---- 誘う → 受ける ----
    a.send('trade:invite', { to: idB });
    if (!await waitFor(() => seenB.invited !== undefined, '誘いが届く')) return;
    check('誘いが相手に届く', seenB.invited?.name === NAME_A, seenB.invited?.name);

    b.send('trade:answer', { ok: true });
    if (!await waitFor(() => seenA.begin !== undefined && seenB.begin !== undefined,
      '卓が開く')) return;
    check('二人とも卓に着いた',
      seenA.begin?.name === NAME_B && seenB.begin?.name === NAME_A);

    // 在室者リストの「取引中」が立つ
    await waitFor(() => {
      const st = a!.state as {
        players?: { forEach(cb: (p: { trading?: boolean }) => void): void };
      };
      let all = true;
      st.players?.forEach(p => { if (p.trading !== true) all = false; });
      return all;
    }, '在室者リストが取引中になる', 5000);
    check('一覧に「取引中」が出る', true);

    // ---- 火(光1ぶん) ⇔ 光1 ----
    a.send('trade:offer', { counts: { fire: RARE_VALUE } });
    if (!await waitFor(() => (seenB.view?.theirs as ElementCounts)?.fire === RARE_VALUE,
      '出したものが相手に見える')) return;
    check('出したものが相手に見える', seenB.view?.theirs.fire === RARE_VALUE);

    // 釣り合う前は準備完了にできない
    seenA.error = undefined;
    a.send('trade:ready', { ready: true });
    if (!await waitFor(() => seenA.error !== undefined, '釣り合い不足の断り')) return;
    check('釣り合う前は準備完了にできない', seenA.view?.myReady === false,
      seenA.error?.text);

    b.send('trade:offer', { counts: { light: 1 } });
    await waitFor(() => seenA.view?.theirs.light === 1, '相手の出し物が届く');

    a.send('trade:ready', { ready: true });
    if (!await waitFor(() => seenB.view?.theirReady === true, '準備完了が相手に伝わる')) return;
    check('準備完了が相手に伝わる', seenB.view?.theirReady === true);
    check('片方だけでは成立しない', seenA.done === undefined);

    b.send('trade:ready', { ready: true });
    if (!await waitFor(() => seenA.done !== undefined && seenB.done !== undefined,
      '取引の成立')) return;
    check('取引が成立した', true);
    check(`Aは火${RARE_VALUE}を渡して光1を受け取る`,
      seenA.done?.give.fire === RARE_VALUE && seenA.done?.get.light === 1,
      JSON.stringify(seenA.done));
    check(`Bは光1を渡して火${RARE_VALUE}を受け取る`,
      seenB.done?.give.light === 1 && seenB.done?.get.fire === RARE_VALUE,
      JSON.stringify(seenB.done));
    check('渡した価値と受け取った価値が等しい',
      countsValue(seenA.done!.give) === countsValue(seenA.done!.get));

    // 成立後は「取引中」が下りる
    await waitFor(() => {
      const st = a!.state as {
        players?: { forEach(cb: (p: { trading?: boolean }) => void): void };
      };
      let any = false;
      st.players?.forEach(p => { if (p.trading === true) any = true; });
      return !any;
    }, '取引中が下りる', 5000);
    check('成立後は「取引中」が下りる', true);

    // ---- 途中で相手が居なくなった場合 ----
    seenA.begin = undefined;
    seenB.invited = undefined;
    a.send('trade:invite', { to: idB });
    await waitFor(() => seenB.invited !== undefined, '2回目の誘い');
    b.send('trade:answer', { ok: true });
    await waitFor(() => seenA.begin !== undefined, '2回目の卓');

    await b.leave();
    b = null;
    if (!await waitFor(() => seenA.closed !== undefined, '相手の退出が伝わる')) return;
    check('相手が居なくなると卓が畳まれて伝わる',
      seenA.closed !== undefined, seenA.closed?.text);
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    try { await a?.leave(); } catch { /* 既に閉じている */ }
    try { await b?.leave(); } catch { /* 既に閉じている */ }
    await releaseNames();
  }

  console.log(ng === 0 ? '\n=== 合格 ===' : `\n=== ${ng}件 失敗 ===`);
  await sleep(300);
  process.exit(ng === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
