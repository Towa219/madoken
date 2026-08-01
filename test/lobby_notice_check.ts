// ロビーへのお知らせ(共闘部屋の募集・決闘の募集)が届くか確認する
// 実行: npx tsx test/lobby_notice_check.ts (サーバー起動済みであること)

import { Client } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const WATCH = `w${RUN}`;   // ロビーで見ている人
const HOST = `h${RUN}`;    // 部屋を作る人

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const notices: string[] = [];
let ng = 0;

function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

async function release(name: string, token: string): Promise<void> {
  try {
    await fetch(`${HTTP_BASE}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch { /* 無視 */ }
}

async function main(): Promise<void> {
  const watcher = new Client(ENDPOINT);
  const host = new Client(ENDPOINT);

  const lobby = await watcher.joinOrCreate('lobby_chat', {
    name: WATCH, nickToken: `tk${RUN}w`,
  });
  lobby.onMessage('chat', (m: { name: string; text: string }) => {
    if (m.name === 'お知らせ') notices.push(m.text);
  });
  await sleep(300);

  // 共闘部屋を作る
  const coop = await host.create('coop', {
    name: HOST, spells: [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }],
    stage: 3, maxStage: 3, nickToken: `tk${RUN}h`,
  });
  await sleep(600);
  check(notices.some(t => t.includes(HOST) && t.includes('ステージ3') && t.includes('共闘部屋')),
    `共闘部屋の募集がロビーに流れた: ${notices.find(t => t.includes('共闘部屋')) ?? '(無し)'}`);

  void coop.leave();
  await sleep(400);

  // 決闘を募集する
  const duel = await host.joinOrCreate('duel', {
    name: HOST, spells: [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }],
    nickToken: `tk${RUN}h`,
  });
  await sleep(600);
  check(notices.some(t => t.includes(HOST) && t.includes('決闘')),
    `決闘の募集がロビーに流れた: ${notices.find(t => t.includes('決闘')) ?? '(無し)'}`);

  void duel.leave();
  void lobby.leave();
  await release(WATCH, `tk${RUN}w`);
  await release(HOST, `tk${RUN}h`);

  console.log(ng === 0 ? '=== ロビーお知らせ 合格 ===' : `=== ${ng}件の不具合 ===`);
  setTimeout(() => process.exit(ng === 0 ? 0 : 1), 800);
}

void main();
