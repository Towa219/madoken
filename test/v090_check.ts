// v0.9.0の確認
//  ① ニックネームの文字数(全角10・半角20)
//  ② エピック/レジェンドのカタカナ真名
//  ③ 本日のTipsが日替わりで変わる

import {
  clampNickname, nickWidth, NICK_MAX_FULL, NICK_MAX_WIDTH, validateNickname,
} from '../shared/nickname';
import { spellNameFor, trueName } from '../shared/spellcraft';
import { todaysTip } from '../src/tips';

let ng = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

console.log(`--- ① ニックネームの長さ(全角${NICK_MAX_FULL} / 半角${NICK_MAX_WIDTH}) ---`);
const zen10 = 'あいうえおかきくけこ';          // 全角10 = 幅20
const zen11 = 'あいうえおかきくけこさ';        // 全角11 = 幅22
const han20 = 'abcdefghij0123456789';          // 半角20
check(nickWidth(zen10) === 20, `「${zen10}」の幅 = ${nickWidth(zen10)}`);
check(validateNickname(zen10) === null, '全角10文字は使える');
check(validateNickname(zen11) !== null, `全角11文字は弾く (${validateNickname(zen11) ?? ''})`);
check(validateNickname(han20) === null, '半角20文字は使える');
check(validateNickname(han20 + 'x') !== null, '半角21文字は弾く');
check(clampNickname(zen11) === zen10, `切り詰め: 「${zen11}」→「${clampNickname(zen11)}」`);

console.log('--- ② 上位品質のカタカナ真名 ---');
const recipes = [
  { fire: 3, dark: 1 }, { water: 2, ice: 2, light: 1 }, { earth: 3 },
  { thunder: 2, wind: 1 }, { dark: 4, fire: 1 },
];
for (const r of recipes) {
  const normal = spellNameFor(r, 'normal');
  const epic = spellNameFor(r, 'epic');
  const legend = spellNameFor(r, 'legend');
  console.log(`   通常: ${normal}`);
  console.log(`   ${'エピック'}: ${epic}`);
  console.log(`   ${'レジェンド'}: ${legend}`);
  if (!/^[ァ-ヶー・]+〈/.test(epic)) { console.log('   ✗ エピックがカタカナでない'); ng++; }
  if (!/^[ァ-ヶー・]+〈/.test(legend)) { console.log('   ✗ レジェンドがカタカナでない'); ng++; }
}
check(trueName({ fire: 3, dark: 1 }, 'normal') === null, '通常品質に真名は付かない');
check(trueName({ fire: 3, dark: 1 }, 'rare') === null, 'レアにも真名は付かない');
check(spellNameFor({ fire: 3 }, 'legend') === spellNameFor({ fire: 3 }, 'legend'),
  '同じ構成なら毎回同じ真名になる');

console.log('--- ③ 本日のTips ---');
const days = [new Date(2026, 7, 2), new Date(2026, 7, 3), new Date(2026, 7, 4), new Date(2026, 7, 5)];
const seen = new Set<string>();
for (const d of days) {
  const t = todaysTip(d);
  console.log(`   ${d.getMonth() + 1}/${d.getDate()}: ${t}`);
  seen.add(t);
}
check(seen.size >= 3, `4日分で${seen.size}種類の話題が出た(日替わりになっている)`);
check(todaysTip(days[0]) === todaysTip(days[0]), '同じ日なら同じ話題');

console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);
