// 同じニックネームの接続が「現在オンライン」に二重に並ばないかを確かめる。
//
// 通信が切れてもサーバーが気づくまで間があるため、自動再接続すると
// 同じ人が2件表示されることがあった。入り直したら古い接続を閉じる仕様を検証する。
//
//   npx tsx test/lobby_dup_check.ts   (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');

const RUN = Math.random().toString(36).slice(2, 7);
const NAME = `tD${RUN}`;
const TOKEN = `tok${RUN}`;

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return false;
}

function namesIn(room: Room): string[] {
  const st = room.state as {
    players?: { forEach(cb: (p: { name: string }) => void): void };
  };
  const out: string[] = [];
  st?.players?.forEach(p => out.push(p.name));
  return out;
}

async function main(): Promise<void> {
  console.log('=== ロビーの同名二重表示の検証 ===');
  console.log(`対象: ${ENDPOINT}  名前: ${NAME}`);

  const client = new Client(ENDPOINT);
  let first: Room | null = null;
  let second: Room | null = null;
  let firstLeaveCode = -1;
  let gotReplacedMsg = false;

  try {
    // 1つ目の接続(切れたことにサーバーがまだ気づいていない古い接続の代わり)
    first = await client.joinOrCreate('lobby_chat', { name: NAME, nickToken: TOKEN });
    first.onLeave((code?: number) => { firstLeaveCode = code ?? -1; });
    first.onMessage('replaced', () => { gotReplacedMsg = true; });
    first.onMessage('chat', () => { /* 受け取るだけ */ });
    await waitFor(() => namesIn(first!).includes(NAME));
    check('1つ目の接続が在室者に載る',
      namesIn(first).filter(n => n === NAME).length === 1);

    // 2つ目の接続(自動再接続に相当)
    second = await client.joinOrCreate('lobby_chat', { name: NAME, nickToken: TOKEN });
    await sleep(1500);

    const names = namesIn(second);
    const dup = names.filter(n => n === NAME).length;
    check('入り直しても同じ名前は1件だけ', dup === 1,
      `${dup}件 / 在室 ${names.length}人`);

    // 古い接続は閉じられ、理由が伝わる。
    // ※切断コードは本番のプロキシ越しだと失われることがあるので、
    //   「理由をメッセージで受け取れること」を必須の条件とする。
    check('古い接続に理由が伝わる(replaced)',
      await waitFor(() => gotReplacedMsg, 8000));
    // 古い接続は在室者から消えている(サーバー側の状態が正)
    check('古い接続は在室者から消える',
      namesIn(second).filter(n => n === NAME).length === 1);

    // 切断そのものの伝わり方は経路次第(本番のプロキシ越しでは届かないことがある)。
    // クライアントは replaced を受け取った時点で自分から抜けるので、判定には使わない。
    const closed = await waitFor(() => firstLeaveCode !== -1, 5000);
    console.log(`  (参考: 切断の通知 ${closed ? `code=${firstLeaveCode}` : 'なし'}`
      + ' — 経路次第なので合否には使わない)');
  } catch (err) {
    check('テストの実行', false, (err as Error).message);
  } finally {
    try { await second?.leave(); } catch { /* 無視 */ }
    try { await first?.leave(); } catch { /* 無視 */ }
    await fetch(`${HTTP_BASE}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, token: TOKEN }),
    }).catch(() => undefined);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
