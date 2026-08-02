// エレメント錬成(余った素材3個 → ランダムな1個)の検証
//   npx tsx test/transmute_check.ts

import {
  ELEMENT_ORDER, ELEMENT_POOL, pickSurplus, TRANSMUTE_COST, transmuteResult,
} from '../shared/data';
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
const show = (ids: ElementId[] | null) =>
  ids ? ids.map(i => names[i]).join('・') : 'なし';

console.log('=== 使う素材の選び方 ===');

check('手持ちが足りなければ選べない',
  pickSurplus({ fire: 2 }) === null, show(pickSurplus({ fire: 2 })));
check('ちょうど3個なら選べる',
  pickSurplus({ fire: 2, water: 1 })?.length === TRANSMUTE_COST,
  show(pickSurplus({ fire: 2, water: 1 })));

const many = pickSurplus({ fire: 9, water: 2, light: 1 });
check('1種類で足りるならその種類だけを使う',
  !!many && many.every(id => id === 'fire'), show(many));

const spread = pickSurplus({ fire: 2, water: 2, wind: 1 });
check('1種類で足りなければ多い順に寄せ集める',
  spread?.length === TRANSMUTE_COST, show(spread));

// 使う素材はこちらで自動選択するので、貴重な光・闇を勝手に消費してはいけない
const keepRare = pickSurplus({ fire: 3, light: 5, dark: 5 });
check('光・闇が多くても、他が足りていれば手を付けない',
  !!keepRare && keepRare.every(id => id === 'fire'), show(keepRare));

const mixRare = pickSurplus({ fire: 2, light: 3, dark: 3 });
check('他が足りない分だけ光・闇を使う',
  !!mixRare && mixRare.filter(id => id === 'fire').length === 2,
  show(mixRare));

const onlyRare = pickSurplus({ light: 2, dark: 1 });
check('光・闇しか無ければ最後の手段として使える',
  onlyRare?.length === TRANSMUTE_COST, show(onlyRare));

check('総数が足りなければ選べない',
  pickSurplus({ light: 1, dark: 1 }) === null);

console.log('');
console.log('=== 錬成の結果 ===');

// 使った種類は出ない(同じものが返ると「減っただけ」になるため)
let sameBack = 0;
for (let i = 0; i < 3000; i++) {
  if (transmuteResult(['fire', 'fire', 'fire']) === 'fire') sameBack++;
}
check('使った種類は出てこない', sameBack === 0, `${sameBack}回`);

// 出る種類が偏りすぎていないか(光・闇も出る)
const count: Record<string, number> = {};
for (let i = 0; i < 20000; i++) {
  const got = transmuteResult(['fire', 'fire', 'fire']);
  count[got] = (count[got] ?? 0) + 1;
}
const got = ELEMENT_ORDER.filter(id => id !== 'fire');
check('火以外の7種類すべてが出る', got.every(id => (count[id] ?? 0) > 0),
  got.map(id => `${names[id]}${count[id] ?? 0}`).join(' '));
check('光と闇は出にくい(それぞれ1割未満)',
  (count.light ?? 0) / 20000 < 0.1 && (count.dark ?? 0) / 20000 < 0.1,
  `光${((count.light ?? 0) / 200).toFixed(1)}% 闇${((count.dark ?? 0) / 200).toFixed(1)}%`);

// 抽選プールに全種類が含まれているか(採取と共通)
check('抽選プールに8種類すべてある',
  ELEMENT_ORDER.every(id => ELEMENT_POOL.includes(id)));

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);
