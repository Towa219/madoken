import type { ElementCounts, ElementId, SpellStats } from './types';

// ===== エレメント定義 =====
// effect: 1個あたりの寄与

export interface ElementDef {
  name: string;
  color: number;       // Pixi用
  cssColor: string;    // DOM用
  desc: string;
}

export const ELEMENT_ORDER: ElementId[] = [
  'fire', 'water', 'wind', 'earth', 'thunder', 'ice', 'light', 'dark',
];

export const ELEMENTS: Record<ElementId, ElementDef> = {
  fire:    { name: '火', color: 0xff6644, cssColor: '#ff6644', desc: '威力+8 / 消費MP+4' },
  water:   { name: '水', color: 0x44aaff, cssColor: '#44aaff', desc: '消費MP-5 / 威力+2' },
  wind:    { name: '風', color: 0x66dd99, cssColor: '#66dd99', desc: '詠唱-0.2秒 / 弾速+70' },
  earth:   { name: '土', color: 0xcc9955, cssColor: '#cc9955', desc: '威力+5 / 消費MP+2' },
  thunder: { name: '雷', color: 0xffdd44, cssColor: '#ffdd44', desc: '弾速+130 / 会心+8%' },
  ice:     { name: '氷', color: 0x99eeff, cssColor: '#99eeff', desc: '威力+3 / 鈍化+12%' },
  light:   { name: '光', color: 0xffffbb, cssColor: '#ffffbb', desc: '威力+2 / 吸収+8%' },
  dark:    { name: '闇', color: 0xbb77ee, cssColor: '#bb77ee', desc: '威力+12 / 自傷+4' },
};

// ===== 隠しレシピ(系統)定義 =====

export interface RecipeDef {
  id: string;
  name: string;        // 系統名
  spellNoun: string;   // 自動命名用(○○弾など)
  hint: string;        // 未発見時のヒント
  desc: string;        // 発見後の説明
  check: (c: ElementCounts) => boolean;
  apply: (s: SpellStats) => void;
}

const n = (c: ElementCounts, id: ElementId) => c[id] ?? 0;

export const RECIPES: RecipeDef[] = [
  {
    id: 'bakuretsu', name: '爆裂系', spellNoun: '爆裂弾',
    hint: '火を極めし者に訪れる (火×3以上)',
    desc: '着弾点が爆発し、範囲内の敵すべてを巻き込む。威力1.2倍。',
    check: c => n(c, 'fire') >= 3,
    apply: s => { s.radius += 90; s.power *= 1.2; },
  },
  {
    id: 'rensa', name: '連鎖系', spellNoun: '連鎖雷',
    hint: '雷が風に乗るとき… (雷×2+風×1以上)',
    desc: '命中後、稲妻が近くの敵2体へ連鎖する(60%威力)。',
    check: c => n(c, 'thunder') >= 2 && n(c, 'wind') >= 1,
    apply: s => { s.chain += 2; },
  },
  {
    id: 'touketsu', name: '凍結系', spellNoun: '凍結槍',
    hint: '氷と水の深き調和 (氷×2+水×1以上)',
    desc: '命中した敵を1.5秒間凍結させ、行動を止める。',
    check: c => n(c, 'ice') >= 2 && n(c, 'water') >= 1,
    apply: s => { s.freeze += 1.5; },
  },
  {
    id: 'jihou', name: '磁砲系', spellNoun: '磁砲',
    hint: '大地に雷が宿るとき (土×2+雷×1以上)',
    desc: '弾が全ての敵を貫通する。弾速1.8倍。',
    check: c => n(c, 'earth') >= 2 && n(c, 'thunder') >= 1,
    apply: s => { s.pierce = true; s.projSpeed *= 1.8; },
  },
  {
    id: 'seiryu', name: '聖流系', spellNoun: '聖流',
    hint: '光は水面に癒しを映す (光×2+水×1以上)',
    desc: '与えたダメージの30%を自分のHPとして吸収する。',
    check: c => n(c, 'light') >= 2 && n(c, 'water') >= 1,
    apply: s => { s.lifesteal += 30; },
  },
  {
    id: 'jishin', name: '地震系', spellNoun: '大地震',
    hint: '大地を三つ重ねれば、世界そのものが武器になる (土×3以上)',
    desc: '弾を放たず大地そのものを揺らし、敵全体にダメージ(威力75%)。大地が裂け、画面が揺れる。',
    check: c => n(c, 'earth') >= 3,
    apply: s => { s.quake = true; },
  },
  {
    id: 'chouhatsu', name: '挑発系', spellNoun: '咆哮',
    hint: '大地を踏み鳴らし火を噴けば、敵は君を見る (土×2+火×1以上)',
    desc: '敵の注意を自分に集める(ヘイト+威力×10)。共闘でタンク役の要。ソロでは小さな護盾に変わる。',
    check: c => n(c, 'earth') >= 2 && n(c, 'fire') >= 1,
    apply: s => { s.kind = 'taunt'; },
  },
  {
    id: 'gojun', name: '護盾系', spellNoun: '護盾',
    hint: '大地と氷は身を守る術を知る (土×2+氷×1以上)',
    desc: '攻撃せず、ダメージを肩代わりする護盾を張る(耐久=威力×2.2・持続10秒)。',
    check: c => n(c, 'earth') >= 2 && n(c, 'ice') >= 1,
    apply: s => { s.kind = 'shield'; },
  },
  {
    id: 'seiiki', name: '聖域系', spellNoun: '聖域盾',
    hint: '守りの大地に光を灯すと、盾は皆を包む (土×2+氷×1+光×1以上)',
    desc: 'パーティ全員に護盾を張る(各自に耐久60%・持続10秒)。ソロでは通常の護盾。',
    check: c => n(c, 'earth') >= 2 && n(c, 'ice') >= 1 && n(c, 'light') >= 1,
    apply: s => { s.kind = 'shield'; s.targetAll = true; },
  },
  {
    id: 'chiyu', name: '治癒系', spellNoun: '治癒光',
    hint: '光を三つ重ねると癒しに転じる (光×3以上)',
    desc: '攻撃せず、最も傷ついた味方(ソロでは自分)のHPを回復する。',
    check: c => n(c, 'light') >= 3,
    apply: s => { s.kind = 'heal'; },
  },
  {
    id: 'jiu', name: '慈雨系', spellNoun: '慈雨',
    hint: '癒しの光が水を得て、雨となり皆に降り注ぐ (光×3+水×1以上)',
    desc: 'パーティ全員を回復する(各自に回復量の60%)。ソロでは自分を回復。',
    check: c => n(c, 'light') >= 3 && n(c, 'water') >= 1,
    apply: s => { s.kind = 'heal'; s.targetAll = true; },
  },
  {
    id: 'konton', name: '混沌系', spellNoun: '混沌撃',
    hint: '闇に火を投じる禁じ手 (闇×2+火×1以上)',
    desc: '威力1.6倍。ただし詠唱のたびに自身も傷つく(+6)。',
    check: c => n(c, 'dark') >= 2 && n(c, 'fire') >= 1,
    apply: s => { s.power *= 1.6; s.selfDamage += 6; },
  },
  {
    id: 'chouwa', name: '調和系', spellNoun: '元素球',
    hint: '四大元素すべてを一つに (火+水+風+土 各1以上)',
    desc: '威力1.15倍・詠唱0.85倍・消費MP0.85倍。全てが噛み合う。',
    check: c => n(c, 'fire') >= 1 && n(c, 'water') >= 1 && n(c, 'wind') >= 1 && n(c, 'earth') >= 1,
    apply: s => { s.power *= 1.15; s.castTime *= 0.85; s.manaCost *= 0.85; },
  },
  {
    id: 'onmyou', name: '陰陽系', spellNoun: '陰陽輪',
    hint: '相反する二つの極が揃うとき、扉は開く… (光×2+闇×2以上)',
    desc: '威力1.5倍・会心+25%。究極魔法へ続く道の入り口とされる。',
    check: c => n(c, 'light') >= 2 && n(c, 'dark') >= 2,
    apply: s => { s.power *= 1.5; s.critRate += 25; },
  },
];

// ===== エレメント相性(5段階) =====
// ◎=2.0倍 / ○=1.5倍 / −=1.0倍 / △=0.6倍 / ✕=0.25倍

export type AffinityGrade = -2 | -1 | 0 | 1 | 2;

export function affinityMul(g: AffinityGrade): number {
  switch (g) {
    case 2: return 2.0;
    case 1: return 1.5;
    case -1: return 0.6;
    case -2: return 0.25;
    default: return 1.0;
  }
}

export function affinitySymbol(g: AffinityGrade): string {
  switch (g) {
    case 2: return '◎';
    case 1: return '○';
    case -1: return '△';
    case -2: return '✕';
    default: return '−';
  }
}

// ===== 敵定義 =====

export interface EnemyDef {
  id: string;
  name: string;
  hp: number;          // 基礎HP(ステージ補正前)
  atk: number;         // 基礎攻撃力
  interval: number;    // 攻撃間隔(秒)
  affinity: Partial<Record<ElementId, AffinityGrade>>; // 未記載は0(等倍)
  attackAttr: ElementId; // 敵の攻撃魔法の属性(弾の見た目に使用)
  color: number;
  size: number;        // 描画スケール
  topY: number;        // 見た目の頭頂Y(スケール前・負値)。名前/HPバーの位置決めに使う
  drops: ElementId[];  // ドロップ候補
}

// 敵の頭上に置く要素のY(接地点からの相対値)
export const enemyTopY = (def: EnemyDef) => def.topY * def.size;

export const ENEMIES: EnemyDef[] = [
  {
    id: 'slime', name: 'スライム', hp: 26, atk: 7, interval: 3.2,
    affinity: { fire: 2, thunder: 1, ice: -1, water: -2 },
    attackAttr: 'water', color: 0x55cc66, size: 1.0, topY: -33,
    drops: ['water', 'water', 'fire', 'wind'],
  },
  {
    id: 'imp', name: 'インプ', hp: 20, atk: 9, interval: 2.6,
    affinity: { light: 2, wind: 1, fire: -1, dark: -2 },
    attackAttr: 'dark', color: 0xdd6688, size: 0.95, topY: -46,
    drops: ['fire', 'dark', 'wind'],
  },
  {
    id: 'golem', name: 'ゴーレム', hp: 48, atk: 8, interval: 4.0,
    affinity: { thunder: 2, water: 1, fire: -1, earth: -2 },
    attackAttr: 'earth', color: 0x998877, size: 1.25, topY: -56,
    drops: ['earth', 'earth', 'thunder'],
  },
  {
    id: 'wisp', name: 'ウィスプ', hp: 16, atk: 7, interval: 2.2,
    affinity: { dark: 2, fire: 1, wind: -1, light: -2 },
    attackAttr: 'light', color: 0xaaddff, size: 0.8, topY: -42,
    drops: ['light', 'ice', 'wind'],
  },
];

export const BOSS: EnemyDef = {
  id: 'core', name: '魔導核', hp: 150, atk: 12, interval: 2.8,
  affinity: { light: 1, dark: 1 },
  attackAttr: 'dark', color: 0xee66ff, size: 1.5, topY: -64,
  drops: ['light', 'dark', 'thunder', 'ice'],
};

// ステージ補正
export const stageHpMul = (stage: number) => Math.pow(1.30, stage - 1);
export const stageAtkMul = (stage: number) => Math.pow(1.15, stage - 1);

// 採取・スロット解放コスト
export const GATHER_COST = 15;
export const SLOT4_COST = 80;
export const SLOT5_COST = 300;
export const DISCOVERY_BONUS_RP = 20;
