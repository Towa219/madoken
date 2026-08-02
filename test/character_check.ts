// キャラクター選択の検証
//   npx tsx test/character_check.ts   (サーバー起動済みであること)
//
// 見た目だけの選択なので、性能に影響しないこと・他のプレイヤーに伝わること・
// 引き継ぎで保たれることを見る。

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { CHARACTERS, CHARACTER_COUNT, clampCharId } from '../shared/characters';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');

const RUN = Math.random().toString(36).slice(2, 7);
const NAME = `tC${RUN}`;
const TOKEN = `tok${RUN}`;
const SPELLS = [{ name: '試験弾', recipe: { fire: 2 }, level: 0, rarity: 'normal' }];

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== キャラクター選択の検証 ===');

  // 1. 定義
  check('キャラクターは5種類', CHARACTER_COUNT === 5, `${CHARACTER_COUNT}種類`);
  check('番号が0から連番', CHARACTERS.every((c, i) => c.id === i));
  check('名前が全て埋まっている', CHARACTERS.every(c => c.name.length > 0));

  // 2. 範囲外・欠損の丸め(古いセーブ・改竄対策)
  check('範囲外は0に丸める',
    clampCharId(-1) === 0 && clampCharId(99) === 0 && clampCharId(undefined) === 0
    && clampCharId('あ') === 0 && clampCharId(null) === 0);
  check('正しい番号はそのまま', clampCharId(3) === 3 && clampCharId('2') === 2);

  // 3. 引き継ぎ(クラウドセーブ)で保たれる
  const save = {
    version: 1, nickname: NAME, charId: 4, researchP: 10,
    inventory: { fire: 1 }, spells: [], equipped: [], discovered: [],
    slots: 2, maxStage: 1, bestStage: 0, bossCleared: [],
    sortByPower: false, codexRewarded: false,
  };
  const put = await fetch(`${HTTP_BASE}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, token: TOKEN, data: save, savedAt: Date.now() }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);
  check('セーブできた', put.ok, put.error ?? '');

  const got = await fetch(`${HTTP_BASE}/api/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, token: TOKEN }),
  }).then(r => r.json() as Promise<{ ok: boolean; data?: { charId?: number } }>);
  check('引き継ぎでキャラの選択が保たれる', got.data?.charId === 4,
    `charId=${got.data?.charId}`);

  // 4. 共闘で他のプレイヤーに伝わる
  const client = new Client(ENDPOINT);
  let room: Room | null = null;
  try {
    room = await client.create('coop', {
      name: NAME, spells: SPELLS, stage: 1, maxStage: 9,
      nickToken: TOKEN, charId: 3,
    });
    room.onMessage('*', () => { /* 受け取るだけ */ });
    await sleep(800);
    const st = room.state as { players?: { get(k: string): { charId?: number } | undefined } };
    const me = st.players?.get(room.sessionId);
    check('共闘ルームにキャラの選択が同期される', me?.charId === 3,
      `charId=${me?.charId}`);

    // 改竄された値はサーバー側で丸められる
    await room.leave();
    room = await client.create('coop', {
      name: NAME, spells: SPELLS, stage: 1, maxStage: 9,
      nickToken: TOKEN, charId: 999,
    });
    room.onMessage('*', () => { /* 受け取るだけ */ });
    await sleep(800);
    const st2 = room.state as { players?: { get(k: string): { charId?: number } | undefined } };
    check('範囲外の値はサーバーが0に丸める',
      st2.players?.get(room.sessionId)?.charId === 0,
      `charId=${st2.players?.get(room.sessionId)?.charId}`);
  } catch (err) {
    check('共闘での同期', false, (err as Error).message);
  } finally {
    try { await room?.leave(); } catch { /* 無視 */ }
    await fetch(`${HTTP_BASE}/api/save/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, token: TOKEN }),
    }).catch(() => undefined);
    await fetch(`${HTTP_BASE}/api/name/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, token: TOKEN }),
    }).catch(() => undefined);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
