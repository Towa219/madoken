// 魔導値ランキングが正しく計算・登録されるかを確かめる。
//
// 見るのは
//   ・スコアが「持っている魔法の上位4つの合計」になっているか
//     (装備中の4つではない。装備の入れ替えで順位が動いてはいけない)
//   ・6本持っていても上位4本だけが数えられるか
//   ・クライアントが魔導値を偽って送っても効かないか
//     (性能はレシピからサーバーが計算し直す)
//   ・他人の名前で登録できないか
//   ・上位3件だけが返るか
//
//   npx tsx test/magic_ranking_check.ts

import { finalStats, spellMagicValue } from '../shared/spellcraft';
import type { ElementCounts, Rarity } from '../shared/types';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Payload {
  name: string;
  recipe: ElementCounts;
  level: number;
  rarity: Rarity;
  power?: number;
}

const spell = (
  name: string, recipe: ElementCounts, level = 0, rarity: Rarity = 'normal',
): Payload => ({ name, recipe, level, rarity });

const valueOf = (s: Payload) =>
  spellMagicValue(finalStats(s.recipe, s.level, s.rarity));

async function submit(name: string, token: string, spells: Payload[]) {
  const res = await fetch(`${HTTP}/api/ranking/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, nickToken: token, spells }),
  });
  return await res.json() as { ok: boolean; score?: number; error?: string };
}

async function release(name: string, token: string): Promise<void> {
  try {
    await fetch(`${HTTP}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch { /* 消せなくてもテストの成否には関係ない */ }
}

async function main(): Promise<void> {
  console.log('=== 魔導値ランキングの検証 ===');
  console.log(`対象: ${HTTP}`);

  const names: [string, string][] = [];
  const mk = (tag: string): [string, string] => {
    const pair: [string, string] = [`r${tag}${RUN}`, `tok_r${tag}${RUN}`];
    names.push(pair);
    return pair;
  };

  // ---- 1. 6本持っていても上位4本だけが合計される ----
  const [nA, tA] = mk('A');
  const six = [
    spell('闇の封印', { dark: 3 }, 3),
    spell('炎の爆裂弾', { fire: 3 }, 4),
    spell('雷の連鎖雷', { wind: 2, thunder: 2 }, 2),
    spell('光の治癒光', { light: 3 }, 2),
    spell('弱い魔弾', { water: 2 }, 0),      // 下位2本。数えられてはいけない
    spell('もっと弱い魔弾', { water: 1, wind: 1 }, 0),
  ];
  const sorted = six.map(valueOf).sort((a, b) => b - a);
  const expect = sorted.slice(0, 4).reduce((x, y) => x + y, 0);

  const r1 = await submit(nA, tA, six);
  check('登録できた', r1.ok, r1.error ?? '');
  check('スコア = 上位4本の合計', r1.score === expect,
    `サーバー=${r1.score} 期待=${expect} (全6本=${sorted.join('+')})`);
  check('下位2本は数えられていない',
    expect < sorted.reduce((x, y) => x + y, 0),
    `上位4本${expect} < 全6本${sorted.reduce((x, y) => x + y, 0)}`);

  // ---- 2. 並び順を変えても同じスコア(=装備順に依存しない) ----
  const shuffled = [...six].reverse();
  const r2 = await submit(nA, tA, shuffled);
  check('並び順を変えてもスコアは同じ', r2.score === expect,
    `${r2.score} vs ${expect}`);

  // ---- 3. 魔導値を偽っても効かない ----
  const [nB, tB] = mk('B');
  const faked = [
    { ...spell('詐称魔弾', { water: 1, wind: 1 }, 0), power: 99999, magicValue: 99999 },
  ] as Payload[];
  const r3 = await submit(nB, tB, faked);
  const honest = valueOf(faked[0]);
  check('偽った威力は無視される', r3.score === honest,
    `サーバー=${r3.score} レシピ通り=${honest}`);

  // ---- 4. 他人の名前では登録できない ----
  const r4 = await submit(nA, 'tok_dare_demo_nai', six);
  check('他人の名前では登録できない', !r4.ok, r4.error ?? '登録できてしまった');

  // ---- 5. 上位3件だけ返る ----
  const res = await fetch(`${HTTP}/api/ranking`);
  const data = await res.json() as {
    entries: { name: string; score: number; spells: string[] }[];
  };
  const entries = data.entries ?? [];
  check('返るのは3件まで', entries.length <= 3, `${entries.length}件`);
  check('スコアの高い順', entries.every((e, i) => i === 0 || entries[i - 1].score >= e.score),
    entries.map(e => e.score).join(' ≧ '));
  const mine = entries.find(e => e.name === nA);
  if (mine) {
    check('自分の記録に上位4本の名前が載っている', mine.spells.length === 4,
      mine.spells.join(' / '));
    check('弱い魔法は載っていない', !mine.spells.includes('もっと弱い魔弾'),
      mine.spells.join(' / '));
  } else {
    console.log('  --  上位3件に入らなかったため、記録の中身の確認は省略');
  }

  for (const [n, t] of names) await release(n, t);
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
