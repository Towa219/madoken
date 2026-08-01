// 2スロット(=2素材)で何が作れるかを調べる
import { ELEMENT_ORDER, RECIPES, START_SLOTS, SLOT3_COST, battleRP } from '../shared/data';
import { computeSpell, spellMagicValue } from '../shared/spellcraft';
import type { ElementCounts, ElementId } from '../shared/types';

function combos(size: number): ElementCounts[] {
  const out: ElementCounts[] = [];
  const cur: ElementCounts = {};
  const walk = (idx: number, left: number): void => {
    if (idx === ELEMENT_ORDER.length) {
      if (size - left === size) out.push({ ...cur });
      return;
    }
    const id = ELEMENT_ORDER[idx] as ElementId;
    for (let k = 0; k <= left; k++) {
      if (k === 0) delete cur[id]; else cur[id] = k;
      walk(idx + 1, left - k);
    }
    delete cur[id];
  };
  walk(0, size);
  return out;
}

const two = combos(2);
console.log(`開始スロット数: ${START_SLOTS}`);
console.log(`2素材で作れる構成: ${two.length}通り`);

const withSystem = two.filter(c => computeSpell(c).matched.length > 0);
console.log(`そのうち系統が成立するもの: ${withSystem.length}通り`);
for (const c of withSystem) {
  const r = computeSpell(c);
  console.log(`  ${r.autoName} → 系統: ${r.matched.map(m => m.name).join('・')}`);
}

// 威力の目安(上位5件)
const ranked = two
  .map(c => ({ c, r: computeSpell(c) }))
  .sort((a, b) => spellMagicValue(b.r.stats) - spellMagicValue(a.r.stats))
  .slice(0, 5);
console.log('\n2素材で作れる強い魔法(魔導値順 上位5):');
for (const { r } of ranked) {
  console.log(`  ${r.autoName} 魔導値${spellMagicValue(r.stats)} / 威力${r.stats.power} MP${r.stats.manaCost}`);
}

// 第3スロットまでの道のり
console.log('\n第3スロット解放まで:');
console.log(`  必要な研究P: ${SLOT3_COST}(開始時の所持は30)`);
console.log(`  ステージ1の勝利で+${battleRP(1, true)} → あと${Math.ceil((SLOT3_COST - 30) / battleRP(1, true))}勝で解放`);
console.log(`  3素材の系統は${RECIPES.length}種類中ほぼ全て。2素材だけでは届かない`);
