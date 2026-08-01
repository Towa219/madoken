import { ELEMENTS, ELEMENT_ORDER, RARITIES, RECIPES } from './data';
import type { RecipeDef } from './data';
import type { ElementCounts, ElementId, Rarity, SpellStats } from './types';

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
    quake: false, wardPct: 0, hpBoost: 0, sealTime: 0, atkBoost: 0,
    dotDps: 0, dotTime: 0,
    power: 10, castTime: 1.3, manaCost: 20, projSpeed: 260,
    radius: 0, pierce: false, chain: 0, critRate: 5,
    lifesteal: 0, freeze: 0, slow: 0, selfDamage: 0,
    attr: 'fire',
  };

  const c = (id: ElementId) => counts[id] ?? 0;

  s.power += 8 * c('fire') + 2 * c('water') + 5 * c('earth')
           + 3 * c('ice') + 2 * c('light') + 12 * c('dark');
  s.manaCost += 6 * c('fire') - 4 * c('water') + 3 * c('earth')
              + 6 * c('dark') + 2 * c('thunder') + 2 * c('light');
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

  // 自動命名: 主属性接頭辞 + 系統名 + 威力階級 + 構成タグ
  // 構成タグ〈火2風〉はレシピの完全な符号なので、
  // エレメントが1つでも違えば必ず別の名前になる。
  // 例: 火3 →「炎の爆裂弾・改〈火3〉」 / 火2+風1 →「炎の魔弾〈火2風〉」
  const prefix = `${ATTR_CHAR[s.attr]}の`;

  const noun = matched.length > 0 ? matched[matched.length - 1].spellNoun : '魔弾';

  let rank = '';
  if (s.power >= 90) rank = '・真';
  else if (s.power >= 55) rank = '・極';
  else if (s.power >= 30) rank = '・改';

  // 構成タグ(定義順に各エレメント+個数。1個は数字省略)
  let comp = '';
  for (const id of ELEMENT_ORDER) {
    const k = c(id);
    if (k > 0) comp += ATTR_CHAR[id] + (k > 1 ? String(k) : '');
  }

  const autoName = `${prefix}${noun}${rank}〈${comp}〉`;

  return { stats: s, matched, autoName };
}

// ===== 上位品質の真名(カタカナ) =====
//
// エピック・レジェンドの魔法には、通常の和名ではなく異国風の「真名」を与える。
// レシピから決まるので、同じ構成なら毎回同じ名前になる。

const TRUE_ROOT: Record<ElementId, string[]> = {
  fire:    ['イグニス', 'フランマ', 'サラマンド'],
  water:   ['アクア', 'ウンディーネ', 'マリス'],
  wind:    ['ヴェント', 'ゼファー', 'シルフィード'],
  earth:   ['テラ', 'ガイア', 'グランド'],
  thunder: ['フルグル', 'トニトルス', 'ライゼン'],
  ice:     ['グラキエス', 'ニヴィス', 'フロスト'],
  light:   ['ルクス', 'ソレイユ', 'ラディア'],
  dark:    ['ノクス', 'アビス', 'ウンブラ'],
};

// 二つ名(レジェンドのみ付く)
const TRUE_EPITHET = [
  'エターナル', 'カタストロフ', 'オーバーロード', 'ジェネシス', 'ラグナロク',
  'インフィニート', 'アポカリプス', 'ヴァルハラ', 'エンドレス', 'ゼニス',
];

// 文字列から安定した数値を作る(同じレシピなら常に同じ名前にするため)
function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// 品質に応じた最終的な魔法名。
// エピック/レジェンドは真名(カタカナ)+構成タグ、それ以外は通常の和名。
export function spellNameFor(counts: ElementCounts, rarity: Rarity): string {
  const tn = trueName(counts, rarity);
  if (!tn) return computeSpell(counts).autoName;
  let comp = '';
  for (const id of ELEMENT_ORDER) {
    const k = counts[id] ?? 0;
    if (k > 0) comp += ATTR_CHAR[id] + (k > 1 ? String(k) : '');
  }
  return `${tn}〈${comp}〉`;
}

// エピック/レジェンドの真名を作る。normalとレアは null(通常の和名を使う)
export function trueName(counts: ElementCounts, rarity: Rarity): string | null {
  if (rarity !== 'epic' && rarity !== 'legend') return null;

  // 構成を多い順に並べ、上位2属性を語幹にする
  const used = ELEMENT_ORDER
    .map(id => ({ id, n: counts[id] ?? 0 }))
    .filter(e => e.n > 0)
    .sort((a, b) => b.n - a.n || ELEMENT_ORDER.indexOf(a.id) - ELEMENT_ORDER.indexOf(b.id));
  if (used.length === 0) return null;

  const seed = hashOf(
    ELEMENT_ORDER.map(id => `${id}${counts[id] ?? 0}`).join('') + rarity,
  );

  const first = TRUE_ROOT[used[0].id][seed % TRUE_ROOT[used[0].id].length];
  const second = used[1]
    ? TRUE_ROOT[used[1].id][(seed >> 3) % TRUE_ROOT[used[1].id].length]
    : '';

  const base = second ? `${first}・${second}` : first;
  if (rarity === 'epic') return base;

  const epithet = TRUE_EPITHET[(seed >> 7) % TRUE_EPITHET.length];
  return `${base}・${epithet}`;
}

// 指定した系統が成立する構成のうち、最も魔導値が高いものを探す。
// (発見図鑑コンプリート報酬など、「その系統の代表的な1本」を作るのに使う)
export function bestCompositionFor(
  recipeId: string, maxElements: number,
): ElementCounts | null {
  const def = RECIPES.find(r => r.id === recipeId);
  if (!def) return null;

  let best: ElementCounts | null = null;
  let bestValue = -1;
  const cur: ElementCounts = {};

  const walk = (idx: number, left: number): void => {
    if (idx === ELEMENT_ORDER.length) {
      const used = maxElements - left;
      if (used < 2 || !def.check(cur)) return;
      const v = spellMagicValue(computeSpell(cur).stats);
      if (v > bestValue) { bestValue = v; best = { ...cur }; }
      return;
    }
    const id = ELEMENT_ORDER[idx];
    for (let k = 0; k <= left; k++) {
      if (k === 0) delete cur[id];
      else cur[id] = k;
      walk(idx + 1, left - k);
    }
    delete cur[id];
  };

  walk(0, Math.max(2, Math.min(6, Math.floor(maxElements))));
  return best;
}

// ===== 強化(同一レシピの再調合) =====

export const ENHANCE_MAX = 9;

// 強化(1段階ごとに威力+8%・詠唱-2%)と品質倍率をまとめて適用する
export function finalStats(
  counts: ElementCounts, level: number, rarity: Rarity = 'normal',
): SpellStats {
  const base = computeSpell(counts).stats;
  const L = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(level || 0)));
  const rDef = RARITIES[rarity] ?? RARITIES.normal;
  const s: SpellStats = { ...base };

  const mul = (1 + 0.08 * L) * rDef.mul;
  s.power = Math.max(1, Math.round(base.power * mul));
  s.castTime = Math.max(0.35, Math.round(base.castTime * (1 - 0.02 * L) * 100) / 100);
  s.critRate = Math.min(80, Math.round(base.critRate + (rDef.mul - 1) * 20));

  // 派生値は最終威力から再計算
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 1.8 + 10);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);
  if (s.kind === 'ward') s.wardPct = wardPctOf(s);
  if (s.kind === 'vigor') s.hpBoost = hpBoostOf(s);
  if (s.kind === 'seal') s.sealTime = sealTimeOf(s);
  if (s.kind === 'empower') s.atkBoost = atkBoostOf(s);
  // 継続ダメージ: 延焼(dotDpsの目印あり)は強め
  if (s.dotTime > 0) s.dotDps = Math.max(1, Math.round(s.power * (s.dotDps > 0 ? 0.28 : 0.18)));
  return s;
}

// 与ダメージ上昇(%)。上限60%、全体版は7割
export function atkBoostOf(s: SpellStats): number {
  const base = Math.min(60, 15 + s.power / 4);
  return Math.round(s.targetAll ? base * 0.7 : base);
}

// 行動不能にする秒数(威力から換算・上限6秒)
export function sealTimeOf(s: SpellStats): number {
  return Math.round(Math.min(6, 2.5 + s.power / 40) * 10) / 10;
}

// 最大HP上昇量(威力から換算。全体版は7割)
export function hpBoostOf(s: SpellStats): number {
  const base = s.power * 2.2 + 20;
  return Math.round(s.targetAll ? base * 0.7 : base);
}

// 耐性値(威力から換算・上限70%。全属性版は7割の効き)
export function wardPctOf(s: SpellStats): number {
  const base = Math.min(70, 25 + s.power * 0.5);
  return Math.round(s.targetAll ? base * 0.7 : base);
}

// 表示名(品質+強化値付き)
export function spellDisplayName(
  sp: { name: string; level?: number; rarity?: Rarity },
): string {
  const lv = sp.level ?? 0;
  const rName = RARITIES[sp.rarity ?? 'normal']?.name ?? '';
  const head = rName ? `【${rName}】` : '';
  return `${head}${sp.name}${lv > 0 ? ` +${lv}` : ''}`;
}

// クールダウン(秒)。攻撃は詠唱依存、護盾/治癒は固定で長め
export function spellCooldown(s: SpellStats): number {
  if (s.kind === 'shield') return 6;
  if (s.kind === 'heal') return 5;
  if (s.kind === 'taunt') return 8;
  if (s.kind === 'ward') return 10;
  if (s.kind === 'vigor') return 14;
  if (s.kind === 'seal') return 16;
  if (s.kind === 'empower') return 14;
  if (s.quake) return 7;
  return 1.2 + s.castTime * 0.5;
}

// ===== 魔導値(魔法の総合的な強さを1つの数値に) =====
// 効果量を「1回の行動あたりの価値 ÷ 拘束時間」で評価し、MP効率と自傷で補正する。

// 欠損した項目を0で埋める(古いセーブの魔法で計算がNaNにならないように)
export function normalizeStats(raw: SpellStats): SpellStats {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    ...raw,
    kind: raw?.kind ?? 'attack',
    attr: raw?.attr ?? 'fire',
    targetAll: !!raw?.targetAll,
    quake: !!raw?.quake,
    pierce: !!raw?.pierce,
    barrier: n(raw?.barrier), healPower: n(raw?.healPower), hateGain: n(raw?.hateGain),
    wardPct: n(raw?.wardPct), hpBoost: n(raw?.hpBoost), sealTime: n(raw?.sealTime),
    atkBoost: n(raw?.atkBoost), dotDps: n(raw?.dotDps), dotTime: n(raw?.dotTime),
    power: n(raw?.power), castTime: n(raw?.castTime), manaCost: n(raw?.manaCost),
    projSpeed: n(raw?.projSpeed), radius: n(raw?.radius), chain: n(raw?.chain),
    critRate: n(raw?.critRate), lifesteal: n(raw?.lifesteal), freeze: n(raw?.freeze),
    slow: n(raw?.slow), selfDamage: n(raw?.selfDamage),
  };
}

export function spellMagicValue(raw: SpellStats): number {
  const s = normalizeStats(raw);
  const cycle = s.castTime + spellCooldown(s) * 0.6; // 1発に要する実時間
  let v = 0;

  if (s.kind === 'attack') {
    let eff = s.power * (1 + s.critRate / 100);
    if (s.quake) eff *= 2.2;              // 敵全体を巻き込む
    if (s.radius > 0) eff *= 1.35;
    if (s.pierce) eff *= 1.3;
    eff *= 1 + s.chain * 0.25;
    if (s.freeze > 0) eff *= 1 + s.freeze * 0.12;
    if (s.slow > 0) eff *= 1 + s.slow / 250;
    if (s.lifesteal > 0) eff *= 1 + s.lifesteal / 160;
    eff += s.dotDps * s.dotTime * 0.8; // 継続ダメージ分
    v = (eff / cycle) * 12;
  } else if (s.kind === 'shield') {
    v = ((s.barrier * (s.targetAll ? 1.9 : 1)) / cycle) * 9;
  } else if (s.kind === 'heal') {
    v = ((s.healPower * (s.targetAll ? 1.9 : 1)) / cycle) * 9;
  } else if (s.kind === 'ward') {
    v = s.wardPct * (s.targetAll ? 2.6 : 1.6);
  } else if (s.kind === 'vigor') {
    v = s.hpBoost * (s.targetAll ? 1.5 : 0.9);
  } else if (s.kind === 'seal') {
    v = s.sealTime * 26;
  } else if (s.kind === 'empower') {
    v = s.atkBoost * (s.targetAll ? 3.2 : 2.0);
  } else {
    v = (s.hateGain / cycle) * 1.4 + 25;   // 挑発
  }

  v *= 1 + Math.max(-0.25, (18 - s.manaCost) / 120); // MP効率
  v -= s.selfDamage * 1.8;
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.round(v));
}

// 装備中の魔法の魔導値合計 = 戦闘力
export function combatPower(spells: { stats: SpellStats }[]): number {
  return spells.reduce((sum, sp) => sum + spellMagicValue(sp.stats), 0);
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
  if (s.kind === 'empower') {
    const parts = [
      s.targetAll
        ? `【戦鼓】全員の与ダメ+${s.atkBoost}%`
        : `【闘気】与ダメ+${s.atkBoost}%`,
      '20秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用14秒',
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'seal') {
    const parts = [
      `【封印】敵全体を${s.sealTime.toFixed(1)}秒 行動不能`,
      '決闘では相手の詠唱を封じる',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用16秒',
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'vigor') {
    const parts = [
      s.targetAll
        ? `【鼓舞】全員の最大HP+${s.hpBoost}`
        : `【活力】最大HP+${s.hpBoost}`,
      '25秒・同量を回復',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用14秒',
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'ward') {
    const parts = [
      s.targetAll
        ? `【万象護符】全属性耐性${s.wardPct}%`
        : `【護符】${ELEMENTS[s.attr].name}属性の被ダメ-${s.wardPct}%`,
      s.targetAll ? '対象:パーティ全員・12秒' : '対象:自分・12秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用10秒',
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
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
  if (s.dotTime > 0) parts.push(`継続${s.dotDps}/秒×${s.dotTime}秒`);
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
