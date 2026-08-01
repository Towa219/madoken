import { ELEMENTS, ELEMENT_ORDER, RECIPES } from './data';
import type { RecipeDef } from './data';
import type { ElementCounts, ElementId, SpellStats } from './types';

// 属性ごとの命名用一文字
const ATTR_CHAR: Record<ElementId, string> = {
  fire: '炎', water: '水', wind: '風', earth: '地',
  thunder: '雷', ice: '氷', light: '光', dark: '闇',
};

export interface CraftResult {
  stats: SpellStats;
  matched: RecipeDef[];
  autoName: string;
}

// エレメント構成から魔法の性能を算出する(調合の核)
export function computeSpell(counts: ElementCounts): CraftResult {
  const s: SpellStats = {
    kind: 'attack', barrier: 0, healPower: 0, hateGain: 0, targetAll: false,
    quake: false,
    power: 10, castTime: 1.3, manaCost: 12, projSpeed: 260,
    radius: 0, pierce: false, chain: 0, critRate: 5,
    lifesteal: 0, freeze: 0, slow: 0, selfDamage: 0,
    attr: 'fire',
  };

  const c = (id: ElementId) => counts[id] ?? 0;

  s.power += 8 * c('fire') + 2 * c('water') + 5 * c('earth')
           + 3 * c('ice') + 2 * c('light') + 12 * c('dark');
  s.manaCost += 4 * c('fire') - 5 * c('water') + 2 * c('earth') + 4 * c('dark');
  s.castTime -= 0.2 * c('wind');
  s.projSpeed += 70 * c('wind') + 130 * c('thunder');
  s.critRate += 8 * c('thunder');
  s.slow += 12 * c('ice');
  s.lifesteal += 8 * c('light');
  s.selfDamage += 4 * c('dark');

  // 属性 = 最多エレメント(同数なら定義順で先のもの)
  let best: ElementId = 'fire';
  let bestCount = -1;
  for (const id of ELEMENT_ORDER) {
    if (c(id) > bestCount) { best = id; bestCount = c(id); }
  }
  s.attr = best;

  // 隠しレシピ判定
  const matched = RECIPES.filter(r => r.check(counts));
  for (const r of matched) r.apply(s);

  // クランプ
  s.castTime = Math.max(0.35, s.castTime);
  s.manaCost = Math.max(4, Math.round(s.manaCost));
  s.power = Math.max(1, Math.round(s.power));
  s.projSpeed = Math.round(s.projSpeed);
  s.critRate = Math.min(80, Math.round(s.critRate));

  // 防御・支援系の性能は威力から換算
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 1.8 + 10);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);

  // 自動命名: 主属性(+副属性)接頭辞 + 系統名 + 威力による階級
  // 例: 火2+風1 →「炎風の魔弾」 / 火3 →「炎の爆裂弾・改」
  let secondary: ElementId | null = null;
  let secondCount = 0;
  for (const id of ELEMENT_ORDER) {
    if (id === s.attr) continue;
    if (c(id) > secondCount) { secondary = id; secondCount = c(id); }
  }
  let prefix = ATTR_CHAR[s.attr];
  if (secondary && secondCount > 0) prefix += ATTR_CHAR[secondary];
  prefix += 'の';

  const noun = matched.length > 0 ? matched[matched.length - 1].spellNoun : '魔弾';

  let rank = '';
  if (s.power >= 90) rank = '・真';
  else if (s.power >= 55) rank = '・極';
  else if (s.power >= 30) rank = '・改';

  // 素材合計数をローマ数字で付与(3個以上)。火3と火4のような構成違いを名前で区別する
  let total = 0;
  for (const id of ELEMENT_ORDER) total += c(id);
  const NUMERALS = ['', '', '', 'Ⅲ', 'Ⅳ', 'Ⅴ'];
  const numeral = NUMERALS[total] ?? 'Ⅴ';

  const autoName = `${prefix}${noun}${numeral}${rank}`;

  return { stats: s, matched, autoName };
}

// ===== 強化(同一レシピの再調合) =====

export const ENHANCE_MAX = 9;

// 強化1段階ごとに威力+8%・詠唱-2%。護盾/回復/ヘイトは威力に連動して再計算
export function applyEnhance(base: SpellStats, level: number): SpellStats {
  const L = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(level || 0)));
  const s: SpellStats = { ...base };
  if (L === 0) return s;
  s.power = Math.round(base.power * (1 + 0.08 * L));
  s.castTime = Math.max(0.35, Math.round(base.castTime * (1 - 0.02 * L) * 100) / 100);
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 1.8 + 10);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);
  return s;
}

// 表示名(強化値付き)
export function spellDisplayName(sp: { name: string; level?: number }): string {
  const lv = sp.level ?? 0;
  return lv > 0 ? `${sp.name} +${lv}` : sp.name;
}

// クールダウン(秒)。攻撃は詠唱依存、護盾/治癒は固定で長め
export function spellCooldown(s: SpellStats): number {
  if (s.kind === 'shield') return 6;
  if (s.kind === 'heal') return 5;
  if (s.kind === 'taunt') return 8;
  if (s.quake) return 7;
  return 1.2 + s.castTime * 0.5;
}

// 性能の表示用テキスト(研究室・戦闘の両方で使用)
export function statsSummary(s: SpellStats): string {
  if (s.kind === 'shield') {
    const head = s.targetAll
      ? `【全体護盾】全員に耐久${Math.round(s.barrier * 0.6)}`
      : `【護盾】耐久${s.barrier}`;
    const parts = [
      head, '持続10秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用6秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    parts.push(`属性:${ELEMENTS[s.attr].name}`);
    return parts.join(' / ');
  }
  if (s.kind === 'heal') {
    const head = s.targetAll
      ? `【全体治癒】全員回復${Math.round(s.healPower * 0.6)}`
      : `【治癒】回復${s.healPower}`;
    const parts = [
      head, s.targetAll ? '対象:パーティ全員' : '対象:最も傷ついた味方',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用5秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    parts.push(`属性:${ELEMENTS[s.attr].name}`);
    return parts.join(' / ');
  }
  if (s.kind === 'taunt') {
    const parts = [
      `【挑発】ヘイト+${s.hateGain}`, '敵の狙いを自分へ',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用8秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    parts.push(`属性:${ELEMENTS[s.attr].name}`);
    return parts.join(' / ');
  }
  const parts = s.quake
    ? [
        `威力${s.power}`, '全体攻撃(地震・威力75%)',
        `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用7秒',
      ]
    : [
        `威力${s.power}`, `詠唱${s.castTime.toFixed(2)}秒`,
        `MP${s.manaCost}`, `弾速${s.projSpeed}`,
      ];
  if (s.radius > 0) parts.push(`爆発${Math.round(s.radius)}`);
  if (s.pierce) parts.push('貫通');
  if (s.chain > 0) parts.push(`連鎖${s.chain}`);
  if (s.critRate > 5) parts.push(`会心${s.critRate}%`);
  if (s.lifesteal > 0) parts.push(`吸収${s.lifesteal}%`);
  if (s.freeze > 0) parts.push(`凍結${s.freeze.toFixed(1)}秒`);
  if (s.slow > 0) parts.push(`鈍化${s.slow}%`);
  if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
  parts.push(`属性:${ELEMENTS[s.attr].name}`);
  return parts.join(' / ');
}
