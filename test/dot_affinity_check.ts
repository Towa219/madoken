// 継続ダメージ(延焼)に属性相性が掛かっているかを見張る。ブラウザもサーバーも要らない。
//
//   npx tsx test/dot_affinity_check.ts
//
// ★ なぜ要るか(2026-08-21)。
//   火に「耐性」や「ほぼ無効」の敵に火の延焼魔法を当てると、
//   着弾の一撃は 0.6倍・0.25倍に弱まるのに、
//   継続ダメージだけが満額で入り続けていた。
//
//   原因は式の順番。dealDamage の中で
//     ① 継続ダメージ(dotDps)を確定する
//     ② そのあと相性(affinityMul)を dmg にだけ掛ける
//   となっていたため、①の時点では相性がまだ掛かっていなかった。
//   一撃と違って画面に「耐性…」とも出ないので、遊んでいて気づけない。
//
// ★ 見張り方は2つ。
//   (1) 相性の倍率そのものが変わっていないか(数字の確認)
//   (2) ソロ(src/battle.ts)と共闘(server/rooms/CoopRoom.ts)の両方で、
//       相性を求める行が継続ダメージを決める行より前にあり、かつ
//       dotDps に affinityMul が掛かっていること(順番の確認)
//
//   ★ 片方だけ直すとソロと共闘で数字が食い違う。必ず両方を見る。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { affinityMul } from '../shared/data';

const ここ = dirname(fileURLToPath(import.meta.url));
const 根 = join(ここ, '..');

let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

console.log('=== 継続ダメージに属性相性が掛かっているか ===');

// ---- (1) 相性の倍率 ----
console.log('\n-- 相性の倍率 --');
確認(affinityMul(2) === 2.0, '大弱点は2.0倍', `実際 ${affinityMul(2)}`);
確認(affinityMul(1) === 1.5, '弱点は1.5倍', `実際 ${affinityMul(1)}`);
確認(affinityMul(0) === 1.0, '等倍は1.0倍', `実際 ${affinityMul(0)}`);
確認(affinityMul(-1) === 0.6, '耐性は0.6倍', `実際 ${affinityMul(-1)}`);
確認(affinityMul(-2) === 0.25, 'ほぼ無効は0.25倍', `実際 ${affinityMul(-2)}`);

// ---- (2) 式の順番と掛け忘れ ----
// dealDamage の中身だけを切り出して見る。ファイル全体を検索すると
// 別の場所にある affinityMul を拾ってしまい、直っていなくても通ってしまう。
function dealDamageの中身(相対パス: string): string {
  const 全文 = readFileSync(join(根, 相対パス), 'utf8');
  const 開始 = 全文.indexOf('private dealDamage(');
  if (開始 < 0) throw new Error(`${相対パス} に dealDamage が見つからない`);
  // 継続ダメージを決める行から少し先までを見れば足りる
  const 終端 = 全文.indexOf('const final = Math.max(1, Math.round(dmg));', 開始);
  if (終端 < 0) throw new Error(`${相対パス} の dealDamage の終わりが分からない`);
  return 全文.slice(開始, 終端);
}

const 対象 = [
  { 名: 'ソロ', path: 'src/battle.ts', dot: 'e.dotDps =' },
  { 名: '共闘', path: 'server/rooms/CoopRoom.ts', dot: 'ei.dotDps =' },
];

for (const t of 対象) {
  console.log(`\n-- ${t.名}(${t.path}) --`);
  const 本体 = dealDamageの中身(t.path);

  const 相性行 = 本体.indexOf('const grade =');
  const 継続行 = 本体.indexOf(t.dot);
  確認(相性行 >= 0, '相性(grade)を求めている');
  確認(継続行 >= 0, '継続ダメージ(dotDps)を決めている');

  確認(相性行 >= 0 && 継続行 >= 0 && 相性行 < 継続行,
    '相性を求めてから継続ダメージを決めている',
    相性行 > 継続行 ? '順番が逆。相性がまだ無い状態で継続ダメージが確定している' : '');

  // dotDps を決めている1行に affinityMul が入っているか
  const 行末 = 本体.indexOf(';', 継続行);
  const 継続の式 = 継続行 >= 0 ? 本体.slice(継続行, 行末 + 1) : '';
  確認(継続の式.includes('affinityMul(grade)'),
    '継続ダメージに相性を掛けている',
    継続の式.includes('affinityMul(grade)') ? '' : `実際の式「${継続の式.trim()}」`);
}

console.log('');
if (失敗数 === 0) {
  console.log('すべて合格。継続ダメージにも属性相性が効いている。');
} else {
  console.error(`${失敗数}件 失敗。耐性持ちに継続ダメージが素通りする恐れがある。`);
  process.exit(1);
}
