// キャラクター選択の検証
//   npx tsx test/character_check.ts   (サーバー起動済みであること)
//
// 見た目だけの選択なので、性能に影響しないこと・他のプレイヤーに伝わること・
// 引き継ぎで保たれることを見る。

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import {
  CHARACTERS, CHARACTER_COUNT, CHAR_POWER_BONUS, clampCharId,
} from '../shared/characters';
import { finalStats } from '../shared/spellcraft';

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
  check('キャラクターは6種類', CHARACTER_COUNT === 6, `${CHARACTER_COUNT}種類`);

  // 6体で 火・水・風・土・雷・氷 をひと通り担当する。
  // 同じ属性が2人いたり抜けがあると、選ぶ意味が薄れる。
  const want = ['fire', 'water', 'wind', 'earth', 'thunder', 'ice'];
  const elems = CHARACTERS.map(c => c.element);
  check('★得意エレメントが6種そろっている',
    want.every(e => elems.filter(g => g === e).length === 1),
    elems.join(' / '));

  // 一言(note)と得意エレメントが食い違っていないか。
  //
  // 得意エレメントを差し替える時、note の書き換えを忘れるのがいちばん起きやすい
  // (選択画面には「💧水の使い手」と note の両方が並ぶので、片方だけ古いと
  //  その場で嘘になる)。実際に白銀と翠緑を入れ替えた時に必要になった見張り。
  // 火を「炎」、土を「大地」と書くなど言い換えがあるので、呼び名は表で持つ。
  const CALLED: Record<string, string[]> = {
    fire: ['火', '炎'], water: ['水'], wind: ['風'], earth: ['土', '大地'],
    thunder: ['雷'], ice: ['氷'],
  };
  const mismatched = CHARACTERS.filter(
    c => !(CALLED[c.element] ?? []).some(word => c.note.includes(word)));
  check('★一言の説明が得意エレメントと合っている',
    mismatched.length === 0,
    mismatched.map(c => `${c.name}(${c.element}) 「${c.note}」`).join(' / ')
      || CHARACTERS.map(c => `${c.name}=${c.element}`).join(' / '));

  // 得意エレメントを含む魔法だけ威力が上がる
  const fireGirl = CHARACTERS.findIndex(c => c.element === 'fire');
  const base = finalStats({ fire: 2 }, 0, 'normal');
  const boosted = finalStats({ fire: 2 }, 0, 'normal', fireGirl);
  const other = finalStats({ water: 2 }, 0, 'normal', fireGirl);
  const otherBase = finalStats({ water: 2 }, 0, 'normal');
  check('★得意エレメントの魔法は威力が上がる', boosted.power > base.power,
    `素 ${base.power} → ${boosted.power}`);
  check(`上がり幅は+${Math.round(CHAR_POWER_BONUS * 100)}%`,
    Math.abs(boosted.power / base.power - (1 + CHAR_POWER_BONUS)) < 0.03,
    `${((boosted.power / base.power - 1) * 100).toFixed(0)}%`);
  check('★得意でないエレメントの魔法は変わらない', other.power === otherBase.power,
    `${otherBase.power} → ${other.power}`);
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
