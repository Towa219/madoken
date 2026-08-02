// 瞑想系(MP自然回復UP)の検証
//   npx tsx test/meisou_check.ts

import { computeSpell, finalStats, spellCooldown, statsSummary } from '../shared/spellcraft';
import type { ElementCounts } from '../shared/types';

const BASE_REGEN = 3; // ソロ/共闘のMP自然回復(毎秒)

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function net(c: ElementCounts, level = 0): number {
  const s = finalStats(c, level);
  return s.mpRegenBonus * 20 - s.manaCost; // 20秒で得られるMPから消費を引く
}

console.log('=== 瞑想系(氷×2+光×1) ===');
const s = computeSpell({ ice: 2, light: 1 }).stats;
console.log(statsSummary(s));
console.log('');

check('氷2+光1 で瞑想系になる', s.kind === 'focus', `kind=${s.kind}`);
check('MP回復の上乗せがある', s.mpRegenBonus > 0, `毎秒+${s.mpRegenBonus}`);
check('再使用は14秒', spellCooldown(s) === 14);
check('20秒で消費MPを上回る(使う意味がある)', net({ ice: 2, light: 1 }) > 0,
  `差し引き ${net({ ice: 2, light: 1 }).toFixed(0)} MP`);

// 他の系統を壊していないこと(条件が重なる組み合わせ)
console.log('');
console.log('=== 条件が重なる組み合わせで、より厳しい系統が勝つか ===');
const cases: [string, ElementCounts, string][] = [
  ['聖域(土2氷1光1)', { earth: 2, ice: 1, light: 1 }, 'shield'],
  ['聖域+氷増し(土2氷2光1)', { earth: 2, ice: 2, light: 1 }, 'shield'],
  ['守護(水2氷2光1)', { water: 2, ice: 2, light: 1 }, 'ward'],
  ['凍結(氷2水1)', { ice: 2, water: 1 }, 'attack'],
  ['瞑想(氷2光1)', { ice: 2, light: 1 }, 'focus'],
  ['瞑想(氷3光2)', { ice: 3, light: 2 }, 'focus'],
];
for (const [label, c, expect] of cases) {
  const k = computeSpell(c).stats.kind;
  check(label, k === expect, `kind=${k}`);
}

// 強化で伸びること
console.log('');
console.log('=== 強化(+9)での伸び ===');
for (const lv of [0, 5, 9]) {
  const f = finalStats({ ice: 2, light: 1 }, lv);
  console.log(
    `+${lv}`.padEnd(3),
    `威力=${String(f.power).padStart(3)}`,
    `毎秒+${f.mpRegenBonus.toFixed(1)}`,
    `(通常${BASE_REGEN} → ${(BASE_REGEN + f.mpRegenBonus).toFixed(1)})`,
    `消費MP=${f.manaCost}`,
    `20秒の差し引き=${net({ ice: 2, light: 1 }, lv).toFixed(0)}MP`,
  );
}

// 回復魔法のような無限化が起きないこと:
// 瞑想を撃ち続けても、増えるMPは有限で頭打ちになる(上限6/秒)
console.log('');
const heavy = finalStats({ ice: 4, light: 2 }, 9);
check('上乗せには上限がある(暴走しない)', heavy.mpRegenBonus <= 6,
  `最大構成でも毎秒+${heavy.mpRegenBonus}`);

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);
