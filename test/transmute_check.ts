// エレメント錬成(同じ素材3個 → ランダムな1個)の検証
//   npx tsx test/transmute_check.ts
//
// 使う素材はプレイヤーが素材庫から選ぶ(3個以上ある種類のみ)。
// ここでは抽選側の性質を確かめる。

import { ELEMENT_ORDER, ELEMENT_POOL, TRANSMUTE_COST, transmuteResult } from '../shared/data';
import type { ElementId } from '../shared/types';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const names: Record<ElementId, string> = {
  fire: '火', water: '水', wind: '風', earth: '土',
  thunder: '雷', ice: '氷', light: '光', dark: '闇',
};

console.log(`=== 錬成の結果(${TRANSMUTE_COST}個 → 1個) ===`);

// 使った種類が返ると「減っただけ」になるので、必ず別の種類が出る
for (const used of ELEMENT_ORDER) {
  let same = 0;
  for (let i = 0; i < 500; i++) {
    if (transmuteResult(Array(TRANSMUTE_COST).fill(used) as ElementId[]) === used) same++;
  }
  if (same > 0) {
    check(`${names[used]}を錬成しても${names[used]}は出ない`, false, `${same}回出た`);
  }
}
check('どの種類を錬成しても、同じ種類は返らない', failures === 0);

// 偏りの確認(火を錬成した場合)
const count: Record<string, number> = {};
const N = 20000;
for (let i = 0; i < N; i++) {
  const got = transmuteResult(['fire', 'fire', 'fire']);
  count[got] = (count[got] ?? 0) + 1;
}
const others = ELEMENT_ORDER.filter(id => id !== 'fire');
check('火以外の7種類すべてが出る', others.every(id => (count[id] ?? 0) > 0),
  others.map(id => `${names[id]}${count[id] ?? 0}`).join(' '));
check('光と闇は出にくい(それぞれ1割未満)',
  (count.light ?? 0) / N < 0.1 && (count.dark ?? 0) / N < 0.1,
  `光${((count.light ?? 0) / N * 100).toFixed(1)}% 闇${((count.dark ?? 0) / N * 100).toFixed(1)}%`);

check('抽選プールに8種類すべてある',
  ELEMENT_ORDER.every(id => ELEMENT_POOL.includes(id)));

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);
