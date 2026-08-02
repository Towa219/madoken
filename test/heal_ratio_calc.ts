// 回復魔法の「MP1あたり何HP戻せるか」を調べる。
// HP→MP変換の魔法を入れる際、無限ループ(HP→MP→回復→HP)にならないかの判断材料。
//   npx tsx test/heal_ratio_calc.ts

import { computeSpell, spellCooldown } from '../shared/spellcraft';
import { PLAYER_MAX_HP, PLAYER_MAX_MP } from '../shared/data';
import type { ElementCounts } from '../shared/types';

console.log(`最大HP=${PLAYER_MAX_HP}  最大MP=${PLAYER_MAX_MP}`);
console.log('');

let best = 0;
function show(label: string, c: ElementCounts): void {
  const s = computeSpell(c).stats;
  const ratio = s.kind === 'heal' ? s.healPower / s.manaCost : 0;
  if (ratio > best) best = ratio;
  console.log(
    label.padEnd(16),
    `系統=${s.kind.padEnd(7)}`,
    `威力=${String(s.power).padStart(3)}`,
    `MP=${String(s.manaCost).padStart(3)}`,
    `回復=${String(s.healPower).padStart(3)}`,
    ratio ? `→ ${ratio.toFixed(2)} HP/MP` : '',
  );
}

show('光3', { light: 3 });
show('光4', { light: 4 });
show('光5', { light: 5 });
show('光3+水1', { light: 3, water: 1 });
show('光3+水2', { light: 3, water: 2 });
show('光4+水1', { light: 4, water: 1 });

console.log('');
console.log(`最も効率の良い回復: ${best.toFixed(2)} HP/MP`);
console.log(`→ HP→MP変換の効率がこれの逆数 ${(1 / best).toFixed(2)} を超えると、`);
console.log('   HP→MP→回復→HP が増え続ける(無限ループになる)。');

// 自然回復のMPだけで回復魔法を撃ち続けられるか(撃てるなら実質HP無限)
console.log('');
console.log('=== 自然回復のMP(毎秒3)だけで回復を撃ち続けられるか ===');
const MP_REGEN = 3;
function sustain(label: string, c: ElementCounts): void {
  const s = computeSpell(c).stats;
  if (s.kind !== 'heal') return;
  const cycle = spellCooldown(s) + s.castTime; // 1回に拘束される秒数
  const regen = MP_REGEN * cycle;              // その間に自然回復するMP
  const ok = regen >= s.manaCost;
  console.log(
    label.padEnd(10),
    `1周=${cycle.toFixed(2)}秒`,
    `必要MP=${String(s.manaCost).padStart(3)}`,
    `自然回復=${regen.toFixed(0).padStart(3)}`,
    ok ? `→ 撃ち続けられる(毎秒 ${(s.healPower / cycle).toFixed(1)} HP を無限に回復)`
       : '→ 撃ち続けられない',
  );
}
sustain('光3', { light: 3 });
sustain('光3+水1', { light: 3, water: 1 });
sustain('光3+水2', { light: 3, water: 2 });
sustain('光3+水3', { light: 3, water: 3 });
