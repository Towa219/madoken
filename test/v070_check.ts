// v0.7.0の3機能を確認する
//  ① 図鑑コンプリート報酬(全系統で報酬用の構成を作れるか)
//  ② ニックネーム規則(スペース禁止・重複キー)
//  ③ 上位品質の確率が魔導書の種類数で上がるか

import { bestCompositionFor, computeSpell, finalStats, spellMagicValue } from '../shared/spellcraft';
import {
  LIBRARY_BONUS_FULL_KINDS, LIBRARY_BONUS_MAX, LIBRARY_BONUS_START,
  RECIPES, libraryBonus, rarityMultiplier,
} from '../shared/data';
import { nicknameKey, validateNickname } from '../shared/nickname';

let ng = 0;

console.log('--- ① 図鑑コンプリート報酬 ---');
for (const r of RECIPES) {
  const c = bestCompositionFor(r.id, 5);
  if (!c) { console.log(`✗ 構成が見つからない: ${r.name}`); ng++; continue; }
  const { matched } = computeSpell(c);
  if (!matched.some(m => m.id === r.id)) { console.log(`✗ 系統が成立しない: ${r.name}`); ng++; }
}
console.log(ng === 0 ? `全${RECIPES.length}系統で報酬用の構成を生成できた` : `NG ${ng}件`);
const sample = bestCompositionFor('jishin', 5);
if (sample) {
  console.log('例(地震系):', JSON.stringify(sample), computeSpell(sample).autoName,
    '魔導値', spellMagicValue(finalStats(sample, 0, 'epic')));
}

console.log('--- ② ニックネーム規則 ---');
const cases: [string, boolean][] = [
  ['ゆりパパ', true], ['yuri papa', false], ['全角　空白', false],
  ['あいうえおかきくけこさしす', false], ['', false], ['<b>', false],
  ['Yuri_2026', false],   // 記号(アンダーバー)は不可
  ['ゆりパパ！', false],   // 全角記号も不可
  ['ゆりパパ★', false],   // 記号
  ['ゆりパパ🔥', false],   // 絵文字
  ['Yuri2026', true],     // 英数字のみは可
  ['魔導士ノ王', true],    // 漢字+カタカナ
  ['ＹＵＲＩ２', true],    // 全角英数字は可
];
for (const [name, expectOk] of cases) {
  const err = validateNickname(name);
  const ok = err === null;
  console.log(`${ok ? 'OK ' : 'NG '} "${name}" → ${err ?? '使用可'}`);
  if (ok !== expectOk) { console.log('  ✗ 期待と違う'); ng++; }
}
if (nicknameKey('ＹＵＲＩ') !== nicknameKey('yuri')) { console.log('✗ 大小/全角の同一視ができていない'); ng++; }
else console.log('OK  「ＹＵＲＩ」と「yuri」は同じ名前として重複扱い');

console.log('--- ③ 上位品質の確率(魔導書の種類数) ---');
for (const k of [0, 5, 10, 11, 20, 35, 60, 80]) {
  console.log(`魔導書${k}種 → 蔵書ボーナス ×${libraryBonus(k).toFixed(2)}`
    + ` / 火3闇1で合計 ×${rarityMultiplier({ fire: 3, dark: 1 }, k).toFixed(2)}`);
}
if (libraryBonus(LIBRARY_BONUS_START) !== 1) { console.log('✗ 開始点まではボーナス無しのはず'); ng++; }
if (libraryBonus(30) <= libraryBonus(LIBRARY_BONUS_START)) { console.log('✗ 種類が増えても上がっていない'); ng++; }
if (libraryBonus(LIBRARY_BONUS_FULL_KINDS) < LIBRARY_BONUS_MAX) { console.log('✗ 上限に届いていない'); ng++; }

console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);
