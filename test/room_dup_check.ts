// 同じキャラで戦闘部屋がいくつも残らないことを確かめる。
//
// 部屋は毎回 client.create('coop') で新しく作られるため、前の部屋に自分の
// 接続が残っていると、その部屋が生き続けて一覧に並んでしまう。
// 新しい部屋に入った時点で古い方が閉じられ、空になった部屋が消えることを見る。
//
//   npx tsx test/room_dup_check.ts   (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');

const RUN = Math.random().toString(36).slice(2, 7);
const NAME = `tR${RUN}`;
const TOKEN = `tok${RUN}`;

const SPELLS = [{ name: '試験弾', recipe: { fire: 2 }, level: 0, rarity: 'normal' }];

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 同じキャラの部屋が乱立しないかの検証 ===');
  console.log(`対象: ${ENDPOINT}  名前: ${NAME}`);

  const client = new Client(ENDPOINT);
  const opts = { name: NAME, spells: SPELLS, stage: 1, maxStage: 9, nickToken: TOKEN };
  let first: Room | null = null;
  let second: Room | null = null;
  let firstReplaced = false;

  // 検証中に他人の部屋が混ざらないよう、自分が作った部屋だけを数える
  const myRoomIds = new Set<string>();

  try {
    first = await client.create('coop', opts);
    myRoomIds.add(first.roomId);
    first.onMessage('replaced', () => { firstReplaced = true; });
    first.onMessage('*', () => { /* 受け取るだけ */ });
    await sleep(500);

    let rooms = await client.getAvailableRooms('coop');
    check('1つ目の部屋ができる',
      rooms.some(r => r.roomId === first!.roomId));

    // 2つ目を作る(前の部屋を閉じ忘れていると2つ並ぶ)
    second = await client.create('coop', opts);
    myRoomIds.add(second.roomId);
    second.onMessage('*', () => { /* 受け取るだけ */ });
    check('2つ目の部屋は別の部屋として作られる',
      second.roomId !== first.roomId);

    check('古い部屋に「閉じる」通知が届く', await waitFor(() => firstReplaced, 8000));

    // 古い部屋は空になり、Colyseus が破棄して一覧から消える
    const gone = await waitFor(async () => {
      rooms = await client.getAvailableRooms('coop');
      return !rooms.some(r => r.roomId === first!.roomId);
    }, 12000);
    check('古い部屋が一覧から消える', gone);

    rooms = await client.getAvailableRooms('coop');
    const mine = rooms.filter(r => myRoomIds.has(r.roomId));
    check('自分の部屋は1つだけ', mine.length === 1,
      `${mine.length}件 (全体では${rooms.length}件)`);
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

async function waitFor(
  cond: () => boolean | Promise<boolean>, ms: number,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(300);
  }
  return false;
}

void main();
