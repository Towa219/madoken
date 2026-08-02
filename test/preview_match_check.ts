// 調合台のプレビューと、実際に作られる魔法が一致するかを全系統で確かめる。
//
// プレビューは computeSpell、実際の魔法は finalStats で作られる。
// 派生値(封印秒数・耐性%・最大HP上昇・与ダメ上昇など)の計算が
// 片方に足りないと、「敵全体を0.0秒 行動不能」のように効果0で表示され、
// 魔導値も1になってしまう(実際の魔法は正常なので気づきにくい)。
//
//   npx tsx test/preview_match_check.ts

import { computeSpell, finalStats, spellMagicValue } from '../shared/spellcraft';
import { ELEMENT_ORDER, RECIPES } from '../shared/data';
import type { ElementCounts, ElementId, SpellStats } from '../shared/types';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// 種類ごとに「これが0だと壊れている」値
const KEY: Record<string, keyof SpellStats> = {
  shield: 'barrier', heal: 'healPower', taunt: 'hateGain',
  ward: 'wardPct', vigor: 'hpBoost', seal: 'sealTime',
  empower: 'atkBoost', focus: 'mpRegenBonus',
};

// その系統が成立する最小の構成を総当たりで探す
function findComposition(check2: (c: ElementCounts) => boolean): ElementCounts | null {
  const cur: ElementCounts = {};
  const walk = (idx: number, left: number): ElementCounts | null => {
    if (idx === ELEMENT_ORDER.length) return check2(cur) ? { ...cur } : null;
    const id = ELEMENT_ORDER[idx];
    for (let k = 0; k <= left; k++) {
      if (k === 0) delete cur[id]; else cur[id] = k;
      const r = walk(idx + 1, left - k);
      if (r) { delete cur[id]; return r; }
    }
    delete cur[id];
    return null;
  };
  return walk(0, 6);
}

const ja: Record<ElementId, string> = {
  fire: '火', water: '水', wind: '風', earth: '土',
  thunder: '雷', ice: '氷', light: '光', dark: '闇',
};
const label = (c: ElementCounts) =>
  ELEMENT_ORDER.filter(id => (c[id] ?? 0) > 0)
    .map(id => ja[id] + ((c[id] ?? 0) > 1 ? String(c[id]) : '')).join('');

console.log('=== 全系統: プレビューと実際の魔法が一致するか ===');

for (const r of RECIPES) {
  const c = findComposition(r.check);
  if (!c) { check(`${r.name}: 作れる構成が見つからない`, false); continue; }

  const preview = computeSpell(c).stats;
  const real = finalStats(c, 0);
  const key = KEY[preview.kind];

  // 種類が一致すること
  if (preview.kind !== real.kind) {
    check(`${r.name}(${label(c)})`, false,
      `種類が違う プレビュー=${preview.kind} 実際=${real.kind}`);
    continue;
  }

  // 効果量が一致し、0でないこと
  if (key) {
    const pv = Number(preview[key]);
    const rv = Number(real[key]);
    if (pv !== rv || pv === 0) {
      check(`${r.name}(${label(c)})`, false,
        `${String(key)}: プレビュー=${pv} 実際=${rv}`);
      continue;
    }
  }

  // 魔導値も一致すること(効果量が0だとここが1に潰れる)
  const pm = spellMagicValue(preview);
  const rm = spellMagicValue(real);
  check(`${r.name}(${label(c)})`, pm === rm,
    pm === rm ? `${preview.kind} 魔導値${pm}` : `魔導値 プレビュー=${pm} 実際=${rm}`);
}

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);
