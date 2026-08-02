// 封印が相手の属性耐性で弱まる仕組みを確かめる。
//
// 闇に強い敵ほど封印も効きにくく、✕(ほぼ無効)の敵にはまったく効かない。
// ソロ・共闘・決闘で別々に書くとすぐ食い違うので、規則は
// shared/spellcraft.ts の sealResistMul / sealWardMul に1つだけ置いてある。
//
// ここで見るのは
//   ・倍率が意図どおりか(△は半分・✕はゼロ)
//   ・実際にレジストする敵が存在するか(0体なら仕組みが死んでいる)
//   ・封印の属性は構成で変わるので、闇以外の封印も判定できるか
//
//   npx tsx test/seal_resist_check.ts

import { BOSSES, ENEMIES } from '../shared/data';
import { finalStats, sealResistMul, sealWardMul } from '../shared/spellcraft';
import type { AffinityGrade, EnemyDef } from '../shared/data';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('=== 封印の耐性判定 ===');

// ---- 1. 倍率 ----
check('◎(大弱点)は等倍', sealResistMul(2) === 1);
check('○(弱点)は等倍', sealResistMul(1) === 1);
check('−(等倍)は等倍', sealResistMul(0) === 1);
check('△(耐性)は半分', sealResistMul(-1) === 0.5);
check('✕(ほぼ無効)はレジスト', sealResistMul(-2) === 0);

// ---- 2. 実際にレジストする敵がいるか ----
const all = [...ENEMIES, ...BOSSES] as EnemyDef[];
const grade = (e: EnemyDef) => (e.affinity.dark ?? 0) as AffinityGrade;
const half = all.filter(e => grade(e) === -1);
const resist = all.filter(e => grade(e) <= -2);

check('闇をレジストする敵がいる', resist.length > 0,
  `${resist.length}体: ${resist.map(e => e.name).join('・')}`);
check('闇に耐性のある敵がいる', half.length > 0,
  `${half.length}体: ${half.map(e => e.name).join('・')}`);
// 全部レジストされては封印が使い物にならない
const ratio = (half.length + resist.length) / all.length;
check(`効きにくい敵は全体の${Math.round(ratio * 100)}%`, ratio > 0.05 && ratio < 0.5,
  `全${all.length}体中${half.length + resist.length}体`);

// ---- 3. 実際の秒数 ----
const seal = finalStats({ dark: 3 }, 0);
check('闇の封印〈闇3〉の属性が闇', seal.attr === 'dark', seal.attr);
const secOf = (g: AffinityGrade) => Math.round(seal.sealTime * sealResistMul(g) * 10) / 10;
console.log(`     等倍の敵 ${secOf(0)}秒 / 耐性の敵 ${secOf(-1)}秒 / ✕の敵 ${secOf(-2)}秒`);
check('等倍の敵には全時間効く', secOf(0) === seal.sealTime);
check('耐性の敵には半分', Math.abs(secOf(-1) - seal.sealTime / 2) < 0.06);
check('✕の敵には効かない', secOf(-2) === 0);

// ---- 4. 封印の属性は構成で変わる ----
// 闇3より多い属性を混ぜると、そちらが封印の属性になる。
const fireSeal = finalStats({ dark: 3, fire: 4 }, 0);
if (fireSeal.kind === 'seal') {
  check('闇より火が多い封印は火属性になる', fireSeal.attr === 'fire', fireSeal.attr);
} else {
  console.log(`  --  闇3+火4は${fireSeal.kind}になるため属性の確認は省略`);
}

// ---- 5. 決闘(護符での軽減) ----
check('護符なしなら全時間', sealWardMul(0) === 1);
check('耐性30%で短くなる', sealWardMul(30) > 0 && sealWardMul(30) < 1, String(sealWardMul(30)));
check('耐性60%でレジスト', sealWardMul(60) === 0);
check('耐性80%でもレジスト', sealWardMul(80) === 0);
// 護符の耐性は最大でどれくらい出るのか(60%に届かないなら決闘では完全には防げない)
console.log(`     決闘: 20%→×${sealWardMul(20)} / 40%→×${sealWardMul(40)} / 50%→×${sealWardMul(50)}`);

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);
