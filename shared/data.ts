import type { ElementCounts, ElementId, Rarity, SpellStats } from './types';

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
  fire:    { name: '火', color: 0xff6644, cssColor: '#ff6644', desc: '威力+8 / 消費MP+6' },
  water:   { name: '水', color: 0x44aaff, cssColor: '#44aaff', desc: '消費MP-4 / 威力+2' },
  wind:    { name: '風', color: 0x66dd99, cssColor: '#66dd99', desc: '詠唱-0.2秒 / 弾速+70' },
  earth:   { name: '土', color: 0xcc9955, cssColor: '#cc9955', desc: '威力+5 / 消費MP+3' },
  thunder: { name: '雷', color: 0xffdd44, cssColor: '#ffdd44', desc: '弾速+130 / 会心+8% / MP+2' },
  ice:     { name: '氷', color: 0x99eeff, cssColor: '#99eeff', desc: '威力+3 / 鈍化+12%' },
  light:   { name: '光', color: 0xffffbb, cssColor: '#ffffbb', desc: '威力+2 / 吸収+8% / MP+2' },
  dark:    { name: '闇', color: 0xbb77ee, cssColor: '#bb77ee', desc: '威力+12 / 自傷+4 / MP+6' },
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
  // --- 基本系統(2素材で成立。最初のスロット数でも発見できる入門枠) ---
  {
    id: 'shakunetsu', name: '灼熱系', spellNoun: '灼熱弾',
    hint: '同じ炎を二つ重ねれば、熱はさらに高まる (火×2以上)',
    desc: '炎が凝縮して威力が1.15倍になる。最初に出会う基本の系統。',
    check: c => n(c, 'fire') >= 2,
    apply: s => { s.power *= 1.15; },
  },
  {
    id: 'shippu', name: '疾風系', spellNoun: '疾風弾',
    hint: '風を二つ重ねれば、術は速さを得る (風×2以上)',
    desc: '詠唱が0.15秒短くなり、弾速が1.4倍になる。手数で押す型の基本。',
    check: c => n(c, 'wind') >= 2,
    apply: s => { s.castTime -= 0.15; s.projSpeed *= 1.4; },
  },
  {
    id: 'seisui', name: '静水系', spellNoun: '水流弾',
    hint: '水を二つ重ねれば、力は静かに流れる (水×2以上)',
    desc: '消費MPが5減り、長く撃ち続けられる。燃費を支える基本の系統。',
    check: c => n(c, 'water') >= 2,
    apply: s => { s.manaCost -= 5; },
  },
  // --- ここから先は条件の厳しい系統(後のものが上書きする) ---
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
    id: 'meisou', name: '瞑想系', spellNoun: '瞑想',
    hint: '氷の静けさに光を灯せば、心は澄み魔力が湧く (氷×2+光×1以上)',
    desc: '攻撃せず、MPの自然回復を20秒間だけ引き上げる(通常は毎秒3)。'
      + '長期戦で魔法を撃ち続けるための系統。',
    check: c => n(c, 'ice') >= 2 && n(c, 'light') >= 1,
    apply: s => { s.kind = 'focus'; },
  },
  // ※ 並び順は「条件がゆるいものを先に」。後のものが上書きするため、
  //   条件の厳しい(素材の多い)系統を後に置かないと、そちらが成立しなくなる。
  {
    id: 'katsuryoku', name: '活力系', spellNoun: '活力',
    hint: '大地の力を光が引き出すとき、体は強くなる (土×2+光×1以上)',
    desc: '最大HPを一時的に増やし、その分だけHPも回復する(25秒・自分)。',
    check: c => n(c, 'earth') >= 2 && n(c, 'light') >= 1,
    apply: s => { s.kind = 'vigor'; },
  },
  {
    id: 'seiiki', name: '聖域系', spellNoun: '聖域盾',
    hint: '守りの大地に光を灯すと、盾は皆を包む (土×2+氷×1+光×1以上)',
    desc: 'パーティ全員に護盾を張る(各自に耐久60%・持続10秒)。ソロでは通常の護盾。',
    check: c => n(c, 'earth') >= 2 && n(c, 'ice') >= 1 && n(c, 'light') >= 1,
    apply: s => { s.kind = 'shield'; s.targetAll = true; },
  },
  {
    id: 'koubu', name: '鼓舞系', spellNoun: '鼓舞',
    hint: '活力に風が加われば、力は仲間にも渡る (土×2+光×1+風×1以上)',
    desc: 'パーティ全員の最大HPを一時的に増やす(25秒・効果は単体版の70%)。',
    check: c => n(c, 'earth') >= 2 && n(c, 'light') >= 1 && n(c, 'wind') >= 1,
    apply: s => { s.kind = 'vigor'; s.targetAll = true; },
  },
  {
    id: 'shugo', name: '守護系', spellNoun: '護符',
    hint: '水を重ね氷で封じれば、その力は身を弾く (水×2+氷×1以上)',
    desc: 'この魔法の属性に対する耐性を自分に付与(12秒)。敵の攻撃属性を見て選ぼう。',
    check: c => n(c, 'water') >= 2 && n(c, 'ice') >= 1,
    apply: s => { s.kind = 'ward'; },
  },
  {
    id: 'banshou', name: '万象護符系', spellNoun: '万象護符',
    hint: '水と氷に風を通せば、守りは全てに及ぶ (水×2+氷×1+風×1以上)',
    desc: '全属性への耐性をパーティ全員に付与(12秒・効果は単体版の70%)。',
    check: c => n(c, 'water') >= 2 && n(c, 'ice') >= 1 && n(c, 'wind') >= 1,
    apply: s => { s.kind = 'ward'; s.targetAll = true; },
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
    id: 'fushoku', name: '腐蝕系', spellNoun: '腐蝕弾',
    hint: '闇を水に溶かせば、じわじわと蝕む毒になる (闇×2+水×1以上)',
    desc: '命中した敵を10秒間むしばみ、毎秒ダメージを与え続ける(重ねがけは上書き)。',
    check: c => n(c, 'dark') >= 2 && n(c, 'water') >= 1,
    apply: s => { s.dotTime = 10; },
  },
  {
    id: 'enjou', name: '延焼系', spellNoun: '延焼弾',
    hint: '火に風を送り続ければ、燃え広がって消えない (火×2+風×2以上)',
    desc: '命中した敵を8秒間燃やし続ける。腐蝕より短いが火力は高い。',
    check: c => n(c, 'fire') >= 2 && n(c, 'wind') >= 2,
    apply: s => { s.dotTime = 8; s.dotDps = 1; }, // dotDps>0 は「強めの継続」の目印
  },
  {
    id: 'touki', name: '闘気系', spellNoun: '闘気',
    hint: '火に雷を通わせると、闘気が身に宿る (火×2+雷×1以上)',
    desc: '一定時間、自分の与えるダメージが上がる(20秒)。',
    check: c => n(c, 'fire') >= 2 && n(c, 'thunder') >= 1,
    apply: s => { s.kind = 'empower'; },
  },
  {
    id: 'senko', name: '戦鼓系', spellNoun: '戦鼓',
    hint: '闘気を風に乗せれば、仲間全員が奮い立つ (火×2+雷×1+風×1以上)',
    desc: 'パーティ全員の与えるダメージが上がる(20秒・効果は単体版の70%)。',
    check: c => n(c, 'fire') >= 2 && n(c, 'thunder') >= 1 && n(c, 'wind') >= 1,
    apply: s => { s.kind = 'empower'; s.targetAll = true; },
  },
  {
    id: 'fuuin', name: '封印系', spellNoun: '封印',
    hint: '闇を三つ束ねると、相手の力そのものを縛れる (闇×3以上)',
    desc: '攻撃せず、敵全体を一定時間だけ行動不能にする。決闘では相手の詠唱を封じる。',
    check: c => n(c, 'dark') >= 3,
    apply: s => { s.kind = 'seal'; },
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

// ===== 魔法のレアリティ =====
// 調合時にごく稀に上位品質が生まれる。品質は性能全体に倍率がかかる。

export interface RarityDef {
  name: string;
  mul: number;       // 性能倍率
  cssColor: string;
  chance: number;    // 基礎出現率(素材構成でボーナス)
}

export const RARITIES: Record<Rarity, RarityDef> = {
  normal: { name: '', mul: 1, cssColor: '#ddddee', chance: 0 },
  // 基礎値は控えめ。素材構成ボーナスと蔵書ボーナスで最大×12程度まで上がる
  rare: { name: 'レア', mul: 1.2, cssColor: '#66aaff', chance: 0.01 },
  epic: { name: 'エピック', mul: 1.5, cssColor: '#cc77ff', chance: 0.001 },
  legend: { name: 'レジェンド', mul: 2.0, cssColor: '#ffcc44', chance: 0.0001 },
};

// 素材が多く、希少エレメント(光・闇)を使うほど上位品質が出やすい
export function rarityBonus(counts: ElementCounts): number {
  let used = 0;
  for (const id of ELEMENT_ORDER) used += n(counts, id);
  const rare = n(counts, 'light') + n(counts, 'dark');
  return 1 + Math.max(0, used - 2) * 0.6 + rare * 0.8;
}

// 魔導書に収めた魔法の「種類」が多いほど上位品質が出やすくなる(研究の蓄積)。
// 少し集めた程度では効かず、蔵書を本気で増やした研究者だけが恩恵を受ける。
export const LIBRARY_BONUS_START = 10;      // ここまではボーナス無し
export const LIBRARY_BONUS_PER_KIND = 0.06; // 超えた分1種類あたり+6%
export const LIBRARY_BONUS_MAX = 4;         // 上限は4倍

// 上限に到達する種類数(60種)
export const LIBRARY_BONUS_FULL_KINDS =
  LIBRARY_BONUS_START + Math.round((LIBRARY_BONUS_MAX - 1) / LIBRARY_BONUS_PER_KIND);

export function libraryBonus(kinds: number): number {
  const over = Math.max(0, Math.floor(kinds || 0)) - LIBRARY_BONUS_START;
  if (over <= 0) return 1;
  return Math.min(LIBRARY_BONUS_MAX, 1 + over * LIBRARY_BONUS_PER_KIND);
}

// 最終的な上位品質の出やすさ(素材ボーナス × 蔵書ボーナス)
export function rarityMultiplier(counts: ElementCounts, kinds: number): number {
  return rarityBonus(counts) * libraryBonus(kinds);
}

export function rollRarity(counts: ElementCounts, kinds = 0): Rarity {
  const b = rarityMultiplier(counts, kinds);
  const r = Math.random();
  if (r < RARITIES.legend.chance * b) return 'legend';
  if (r < RARITIES.epic.chance * b) return 'epic';
  if (r < RARITIES.rare.chance * b) return 'rare';
  return 'normal';
}

// ===== 敵定義 =====

// 見た目の形状(描画は battle.ts の makeEnemySprite が担当)
export type EnemyShape =
  | 'blob' | 'imp' | 'golem' | 'wisp' | 'orb' | 'beast' | 'bird'
  | 'plant' | 'undead' | 'knight' | 'serpent' | 'insect' | 'eye' | 'fish';

// 形状ごとの頭頂Y(スケール前・負値)。名前/HPバーの位置決めに使う
export const SHAPE_TOP: Record<EnemyShape, number> = {
  blob: -33, imp: -46, golem: -56, wisp: -42, orb: -64, beast: -44,
  bird: -52, plant: -54, undead: -58, knight: -62, serpent: -56,
  insect: -38, eye: -46, fish: -40,
};

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
  shape: EnemyShape;
  tier: number;        // 出現帯(1〜8)
  drops: ElementId[];  // ボス撃破時の報酬候補
}

// キャラクターの表示倍率。見た目だけの調整で、性能や当たり判定の計算には影響しない。
// プレイヤー・敵・頭上のバーや名前が、まとめてこの倍率で拡大される。
export const SPRITE_SCALE = 1.5;

// 敵だけにさらにかかる倍率(敵はプレイヤーより小さく見えていたので別枠で調整する)
export const ENEMY_SCALE = 1.5;

// 敵の頭上に置く要素のY(接地点からの相対値)
export const enemyTopY = (def: EnemyDef) =>
  SHAPE_TOP[def.shape] * def.size * SPRITE_SCALE * ENEMY_SCALE;

export const ENEMIES: EnemyDef[] = [
  // --- tier1 (ステージ1〜4) ---
  { id: 'slime', name: 'スライム', hp: 26, atk: 7, interval: 3.2, tier: 1,
    affinity: { fire: 2, thunder: 1, ice: -1, water: -2 },
    attackAttr: 'water', color: 0x55cc66, size: 1.0, shape: 'blob', drops: ['water'] },
  { id: 'imp', name: 'インプ', hp: 20, atk: 9, interval: 2.6, tier: 1,
    affinity: { light: 2, wind: 1, fire: -1, dark: -2 },
    attackAttr: 'dark', color: 0xdd6688, size: 0.95, shape: 'imp', drops: ['dark'] },
  { id: 'golem', name: 'ゴーレム', hp: 48, atk: 8, interval: 4.0, tier: 1,
    affinity: { thunder: 2, water: 1, fire: -1, earth: -2 },
    attackAttr: 'earth', color: 0x998877, size: 1.25, shape: 'golem', drops: ['earth'] },
  { id: 'wisp', name: 'ウィスプ', hp: 16, atk: 7, interval: 2.2, tier: 1,
    affinity: { dark: 2, fire: 1, wind: -1, light: -2 },
    attackAttr: 'light', color: 0xaaddff, size: 0.8, shape: 'wisp', drops: ['light'] },
  { id: 'bat', name: 'ヨルコウモリ', hp: 18, atk: 8, interval: 2.0, tier: 1,
    affinity: { light: 2, fire: 1, wind: -1, dark: -1 },
    attackAttr: 'dark', color: 0x8877aa, size: 0.85, shape: 'bird', drops: ['dark'] },

  // --- tier2 (5〜9) ---
  { id: 'wolf', name: 'モリオオカミ', hp: 42, atk: 12, interval: 2.4, tier: 2,
    affinity: { fire: 2, ice: 1, wind: -1, earth: -1 },
    attackAttr: 'wind', color: 0x778899, size: 1.05, shape: 'beast', drops: ['wind'] },
  { id: 'poisonflower', name: 'ドクバナ', hp: 38, atk: 10, interval: 3.0, tier: 2,
    affinity: { fire: 2, light: 1, water: -2, earth: -1 },
    attackAttr: 'earth', color: 0xaa66bb, size: 1.0, shape: 'plant', drops: ['earth'] },
  { id: 'skeleton', name: 'ガイコツ兵', hp: 46, atk: 11, interval: 2.8, tier: 2,
    affinity: { light: 2, earth: 1, dark: -2, ice: -1 },
    attackAttr: 'dark', color: 0xddddcc, size: 1.05, shape: 'undead', drops: ['dark'] },
  { id: 'salamander', name: 'ヒトカゲリ', hp: 40, atk: 13, interval: 2.6, tier: 2,
    affinity: { water: 2, ice: 1, fire: -2, earth: -1 },
    attackAttr: 'fire', color: 0xff7733, size: 0.95, shape: 'serpent', drops: ['fire'] },
  { id: 'spider', name: 'オオグモ', hp: 36, atk: 12, interval: 2.2, tier: 2,
    affinity: { fire: 2, wind: 1, dark: -1, earth: -1 },
    attackAttr: 'earth', color: 0x664466, size: 1.0, shape: 'insect', drops: ['earth'] },

  // --- tier3 (10〜14) ---
  { id: 'icewolf', name: 'ヒョウガロウ', hp: 62, atk: 16, interval: 2.4, tier: 3,
    affinity: { fire: 2, thunder: 1, ice: -2, water: -1 },
    attackAttr: 'ice', color: 0x99ddff, size: 1.1, shape: 'beast', drops: ['ice'] },
  { id: 'thunderbird', name: 'ライメイチョウ', hp: 54, atk: 18, interval: 2.0, tier: 3,
    affinity: { earth: 2, ice: 1, thunder: -2, wind: -1 },
    attackAttr: 'thunder', color: 0xffdd66, size: 1.05, shape: 'bird', drops: ['thunder'] },
  { id: 'sandgolem', name: 'スナゴーレム', hp: 90, atk: 15, interval: 3.8, tier: 3,
    affinity: { water: 2, thunder: 1, earth: -2, fire: -1 },
    attackAttr: 'earth', color: 0xddbb77, size: 1.3, shape: 'golem', drops: ['earth'] },
  { id: 'acidslime', name: 'フショクスライム', hp: 70, atk: 14, interval: 3.0, tier: 3,
    affinity: { ice: 2, light: 1, water: -2, dark: -1 },
    attackAttr: 'water', color: 0xaacc33, size: 1.15, shape: 'blob', drops: ['water'] },
  { id: 'ghostknight', name: 'ボウレイ騎士', hp: 76, atk: 17, interval: 2.9, tier: 3,
    affinity: { light: 2, fire: 1, dark: -2, earth: -1 },
    attackAttr: 'dark', color: 0x6688aa, size: 1.15, shape: 'knight', drops: ['dark'] },

  // --- tier4 (15〜19) ---
  { id: 'lavabeast', name: 'ヨウガンジュウ', hp: 105, atk: 22, interval: 2.7, tier: 4,
    affinity: { water: 2, ice: 2, fire: -2, earth: -1 },
    attackAttr: 'fire', color: 0xff5522, size: 1.2, shape: 'beast', drops: ['fire'] },
  { id: 'deepfish', name: 'シンカイギョ', hp: 98, atk: 20, interval: 2.5, tier: 4,
    affinity: { thunder: 2, light: 1, water: -2, ice: -1 },
    attackAttr: 'water', color: 0x3366aa, size: 1.1, shape: 'fish', drops: ['water'] },
  { id: 'sylph', name: 'カゼノセイ', hp: 84, atk: 19, interval: 1.9, tier: 4,
    affinity: { earth: 2, ice: 1, wind: -2, light: -1 },
    attackAttr: 'wind', color: 0x99ffcc, size: 0.95, shape: 'wisp', drops: ['wind'] },
  { id: 'basilisk', name: 'セキカヘビ', hp: 112, atk: 21, interval: 3.1, tier: 4,
    affinity: { water: 2, wind: 1, earth: -2, dark: -1 },
    attackAttr: 'earth', color: 0x77aa55, size: 1.2, shape: 'serpent', drops: ['earth'] },
  { id: 'necromancer', name: 'シジュツシ', hp: 92, atk: 23, interval: 2.8, tier: 4,
    affinity: { light: 2, fire: 1, dark: -2, ice: -1 },
    attackAttr: 'dark', color: 0x554466, size: 1.1, shape: 'undead', drops: ['dark'] },

  // --- tier5 (20〜24) ---
  { id: 'flamedragon', name: 'ゴウカリュウ', hp: 150, atk: 28, interval: 2.6, tier: 5,
    affinity: { water: 2, ice: 1, fire: -2, thunder: -1 },
    attackAttr: 'fire', color: 0xdd3311, size: 1.35, shape: 'serpent', drops: ['fire'] },
  { id: 'frostknight', name: 'ヒョウケツ騎士', hp: 165, atk: 26, interval: 3.0, tier: 5,
    affinity: { fire: 2, thunder: 1, ice: -2, water: -1 },
    attackAttr: 'ice', color: 0x88ccee, size: 1.25, shape: 'knight', drops: ['ice'] },
  { id: 'stormlord', name: 'ライチョウオウ', hp: 140, atk: 30, interval: 2.1, tier: 5,
    affinity: { earth: 2, dark: 1, thunder: -2, wind: -1 },
    attackAttr: 'thunder', color: 0xffee88, size: 1.2, shape: 'bird', drops: ['thunder'] },
  { id: 'treant', name: 'タイジュノケシン', hp: 195, atk: 25, interval: 3.6, tier: 5,
    affinity: { fire: 2, ice: 1, earth: -2, water: -2 },
    attackAttr: 'earth', color: 0x669955, size: 1.4, shape: 'plant', drops: ['earth'] },
  { id: 'shadoweater', name: 'カゲクライ', hp: 145, atk: 29, interval: 2.4, tier: 5,
    affinity: { light: 2, fire: 1, dark: -2, wind: -1 },
    attackAttr: 'dark', color: 0x442255, size: 1.15, shape: 'eye', drops: ['dark'] },

  // --- tier6 (25〜29) ---
  { id: 'infernogiant', name: 'シャクネツキョジン', hp: 240, atk: 36, interval: 3.2, tier: 6,
    affinity: { water: 2, ice: 2, fire: -2, earth: -1 },
    attackAttr: 'fire', color: 0xff6600, size: 1.5, shape: 'golem', drops: ['fire'] },
  { id: 'glacierdragon', name: 'ゼツヒョウリュウ', hp: 230, atk: 34, interval: 2.8, tier: 6,
    affinity: { fire: 2, thunder: 1, ice: -2, water: -2 },
    attackAttr: 'ice', color: 0x66bbee, size: 1.45, shape: 'serpent', drops: ['ice'] },
  { id: 'tempestlord', name: 'アラシノヌシ', hp: 210, atk: 38, interval: 2.2, tier: 6,
    affinity: { earth: 2, light: 1, wind: -2, thunder: -2 },
    attackAttr: 'wind', color: 0x88ffdd, size: 1.35, shape: 'wisp', drops: ['wind'] },
  { id: 'terralord', name: 'ダイチノヌシ', hp: 280, atk: 33, interval: 3.8, tier: 6,
    affinity: { water: 2, wind: 1, earth: -2, thunder: -1 },
    attackAttr: 'earth', color: 0xbb8844, size: 1.55, shape: 'beast', drops: ['earth'] },
  { id: 'voideye', name: 'キョムノメ', hp: 215, atk: 37, interval: 2.5, tier: 6,
    affinity: { light: 2, thunder: 1, dark: -2, ice: -1 },
    attackAttr: 'dark', color: 0x331144, size: 1.3, shape: 'eye', drops: ['dark'] },

  // --- tier7 (30〜34) ---
  { id: 'flameemperor', name: 'エンオウ', hp: 340, atk: 45, interval: 2.9, tier: 7,
    affinity: { water: 2, ice: 1, fire: -2, light: -1 },
    attackAttr: 'fire', color: 0xff3300, size: 1.5, shape: 'knight', drops: ['fire'] },
  { id: 'iceemperor', name: 'ヒョウオウ', hp: 350, atk: 43, interval: 3.0, tier: 7,
    affinity: { fire: 2, earth: 1, ice: -2, water: -1 },
    attackAttr: 'ice', color: 0x44aaff, size: 1.5, shape: 'knight', drops: ['ice'] },
  { id: 'thunderemperor', name: 'ライオウ', hp: 320, atk: 48, interval: 2.3, tier: 7,
    affinity: { earth: 2, water: 1, thunder: -2, wind: -1 },
    attackAttr: 'thunder', color: 0xffcc00, size: 1.45, shape: 'bird', drops: ['thunder'] },
  { id: 'earthemperor', name: 'チオウ', hp: 400, atk: 42, interval: 3.9, tier: 7,
    affinity: { thunder: 2, wind: 1, earth: -2, fire: -1 },
    attackAttr: 'earth', color: 0x996633, size: 1.6, shape: 'golem', drops: ['earth'] },
  { id: 'darkemperor', name: 'アンオウ', hp: 330, atk: 47, interval: 2.6, tier: 7,
    affinity: { light: 2, fire: 1, dark: -2, earth: -1 },
    attackAttr: 'dark', color: 0x552277, size: 1.5, shape: 'undead', drops: ['dark'] },

  // --- tier8 (35以上) ---
  { id: 'skydragon', name: 'テンクウリュウ', hp: 480, atk: 55, interval: 2.7, tier: 8,
    affinity: { dark: 2, earth: 1, light: -2, wind: -2 },
    attackAttr: 'light', color: 0xffffcc, size: 1.6, shape: 'serpent', drops: ['light'] },
  { id: 'abyssdragon', name: 'シンエンリュウ', hp: 490, atk: 56, interval: 2.7, tier: 8,
    affinity: { light: 2, thunder: 1, dark: -2, water: -2 },
    attackAttr: 'dark', color: 0x223355, size: 1.6, shape: 'serpent', drops: ['dark'] },
  { id: 'holyknight', name: 'セイコウ騎士', hp: 520, atk: 52, interval: 3.1, tier: 8,
    affinity: { dark: 2, earth: 1, light: -2, fire: -1 },
    attackAttr: 'light', color: 0xffffaa, size: 1.55, shape: 'knight', drops: ['light'] },
  { id: 'chaosbeast', name: 'コントンジュウ', hp: 540, atk: 54, interval: 2.9, tier: 8,
    affinity: { light: 1, dark: 1, fire: -1, ice: -1 },
    attackAttr: 'dark', color: 0x883366, size: 1.65, shape: 'beast', drops: ['dark'] },
  { id: 'endeye', name: 'シュウエンノメ', hp: 500, atk: 58, interval: 2.5, tier: 8,
    affinity: { light: 2, water: 1, dark: -2, thunder: -1 },
    attackAttr: 'dark', color: 0x110022, size: 1.55, shape: 'eye', drops: ['dark'] },
];

// ===== ボス(5の倍数ステージ・共闘2人以上専用) =====

export const BOSSES: EnemyDef[] = [
  { id: 'core', name: '魔導核', hp: 150, atk: 14, interval: 2.8, tier: 1,
    affinity: { light: 1, dark: 1 },
    attackAttr: 'dark', color: 0xee66ff, size: 1.5, shape: 'orb',
    drops: ['light', 'dark', 'thunder', 'ice'] },
  { id: 'stoneguardian', name: '石の守護者', hp: 300, atk: 20, interval: 3.4, tier: 2,
    affinity: { thunder: 2, water: 1, earth: -2, fire: -1 },
    attackAttr: 'earth', color: 0x889988, size: 1.6, shape: 'golem',
    drops: ['earth', 'earth', 'thunder', 'light'] },
  { id: 'crimsondragon', name: '紅蓮竜', hp: 480, atk: 28, interval: 2.9, tier: 3,
    affinity: { water: 2, ice: 2, fire: -2, wind: -1 },
    attackAttr: 'fire', color: 0xcc2222, size: 1.7, shape: 'serpent',
    drops: ['fire', 'fire', 'dark', 'light'] },
  { id: 'icequeen', name: '氷獄女王', hp: 700, atk: 34, interval: 2.8, tier: 4,
    affinity: { fire: 2, thunder: 1, ice: -2, water: -2 },
    attackAttr: 'ice', color: 0x99ddff, size: 1.65, shape: 'knight',
    drops: ['ice', 'ice', 'water', 'light'] },
  { id: 'thunderking', name: '雷帝', hp: 950, atk: 42, interval: 2.2, tier: 5,
    affinity: { earth: 2, dark: 1, thunder: -2, wind: -2 },
    attackAttr: 'thunder', color: 0xffee44, size: 1.7, shape: 'bird',
    drops: ['thunder', 'thunder', 'wind', 'dark'] },
  { id: 'gaia', name: '大地母神', hp: 1400, atk: 46, interval: 3.6, tier: 6,
    affinity: { water: 2, wind: 1, earth: -2, ice: -1 },
    attackAttr: 'earth', color: 0x88bb66, size: 1.8, shape: 'plant',
    drops: ['earth', 'earth', 'water', 'light'] },
  { id: 'seraph', name: '光輝天使', hp: 1800, atk: 54, interval: 2.7, tier: 7,
    affinity: { dark: 2, fire: 1, light: -2, thunder: -1 },
    attackAttr: 'light', color: 0xffffdd, size: 1.75, shape: 'knight',
    drops: ['light', 'light', 'light', 'dark'] },
  { id: 'abysslord', name: '深淵の主', hp: 2300, atk: 60, interval: 2.6, tier: 8,
    affinity: { light: 2, water: 1, dark: -2, earth: -1 },
    attackAttr: 'dark', color: 0x221133, size: 1.8, shape: 'eye',
    drops: ['dark', 'dark', 'dark', 'light'] },
  { id: 'stareater', name: '星喰らい', hp: 3000, atk: 68, interval: 2.5, tier: 8,
    affinity: { light: 1, dark: 1, thunder: -1 },
    attackAttr: 'dark', color: 0x4422aa, size: 1.85, shape: 'orb',
    drops: ['light', 'dark', 'thunder', 'ice'] },
  { id: 'endcore', name: '終焉の魔導核', hp: 4000, atk: 76, interval: 2.4, tier: 8,
    affinity: { light: 1, dark: 1 },
    attackAttr: 'light', color: 0xff66cc, size: 1.9, shape: 'orb',
    drops: ['light', 'light', 'dark', 'dark'] },
];

export const isBossStage = (stage: number) => stage % 5 === 0;

export function bossForStage(stage: number): EnemyDef {
  const idx = Math.max(0, Math.floor(stage / 5) - 1);
  return BOSSES[Math.min(idx, BOSSES.length - 1)];
}

// ステージに応じた通常敵の抽選(高ステージほど上位tierが出る)
export function pickEnemiesForStage(stage: number): EnemyDef[] {
  const tier = Math.max(1, Math.min(8, Math.ceil(stage / 5)));
  const pool = ENEMIES.filter(e => e.tier === tier || e.tier === tier - 1);
  const src = pool.length > 0 ? pool : ENEMIES;
  const count = Math.min(3, 1 + Math.floor((stage - 1) / 2));
  const out: EnemyDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push(src[Math.floor(Math.random() * src.length)]);
  }
  return out;
}

// 全ての敵(図鑑・描画辞書用)
export const ALL_ENEMIES: EnemyDef[] = [...ENEMIES, ...BOSSES];

// ===== 戦闘バランス =====
// 戦闘が一瞬で終わらないよう、両者のHPを厚くし敵の攻撃力は控えめにする

export const PLAYER_MAX_HP = 260;
export const PLAYER_MAX_MP = 120;
export const DUEL_MAX_HP = 300;   // 決闘は読み合いのぶんさらに長め
export const DUEL_MAX_MP = 140;
export const ENEMY_HP_MUL = 3.5;  // 敵HPの全体倍率
export const ENEMY_ATK_MUL = 0.8; // 敵攻撃力の全体倍率

// ステージ補正(tier別の基礎値で強さを表すため、伸びは緩やかに)
export const stageHpMul = (stage: number) => Math.pow(1.15, stage - 1);
export const stageAtkMul = (stage: number) => Math.pow(1.07, stage - 1);

// 採取・スロット解放コスト
export const GATHER_COST = 35;   // 採取は高価に(エレメントは貴重)
export const GATHER_COUNT = 1;   // 1回の採取で得られる数(ランダム1個)
export const START_SLOTS = 2;        // 最初は2スロット(調合は2素材から)
export const SLOT3_COST = 40;        // 第3スロットは研究Pのみで解放
export const SLOT4_COST = 120;
export const SLOT5_COST = 400;
export const SLOT4_BOSS_STAGE = 10;  // 第4スロットに必要なボス撃破ステージ
export const SLOT5_BOSS_STAGE = 20;
export const DISCOVERY_BONUS_RP = 25;
export const DISASSEMBLE_RATE = 0.4; // 分解時に素材1個が戻る確率

// ===== エレメント錬成(余った素材3つ → ランダムな1つ) =====
//
// ※「分解」は魔法を素材に戻す機能の名前として既に使っているため、
//   エレメント同士の作り替えは「錬成」と呼ぶ。

export const TRANSMUTE_COST = 3; // 錬成に使うエレメントの数

// 採取・錬成で引く抽選プール(希少な光・闇は出にくい)
export const ELEMENT_POOL: ElementId[] = [
  'fire', 'fire', 'fire', 'water', 'water', 'water',
  'wind', 'wind', 'wind', 'earth', 'earth', 'earth',
  'thunder', 'thunder', 'ice', 'ice', 'light', 'dark',
];

// 錬成で自動選択したくない希少エレメント。
// 使う素材はこちらで選ぶので、貴重な光・闇は他が尽きるまで手を付けない。
const TRANSMUTE_LAST_RESORT: ElementId[] = ['light', 'dark'];

// 錬成で使う素材を選ぶ。余っている(手持ちが最も多い)種類から取る。
// 同じ種類で足りるならそれだけを使い、足りなければ多い順に寄せ集める。
// 光・闇は他の素材が尽きた場合のみ使う。使える素材が足りなければ null。
export function pickSurplus(
  free: Partial<Record<ElementId, number>>, need = TRANSMUTE_COST,
): ElementId[] | null {
  const left: Record<string, number> = {};
  for (const id of ELEMENT_ORDER) left[id] = Math.max(0, Math.floor(free[id] ?? 0));

  // 総数が足りているかを先に見る(光・闇しか無い場合もここで通す)
  let total = 0;
  for (const id of ELEMENT_ORDER) total += left[id];
  if (total < need) return null;

  // 希少でないものを優先し、その中で手持ちが多い順に選ぶ
  const rank = (id: ElementId): number =>
    (TRANSMUTE_LAST_RESORT.includes(id) ? 0 : 1_000_000) + left[id];

  // 1種類でまかなえるなら、その種類だけを使う(何が減るか分かりやすい)
  let top: ElementId | null = null;
  for (const id of ELEMENT_ORDER) {
    if (left[id] > 0 && (top === null || rank(id) > rank(top))) top = id;
  }
  if (top !== null && left[top] >= need) return Array(need).fill(top) as ElementId[];

  // 足りない場合は寄せ集める
  const picks: ElementId[] = [];
  for (let i = 0; i < need; i++) {
    let best: ElementId | null = null;
    for (const id of ELEMENT_ORDER) {
      if (left[id] > 0 && (best === null || rank(id) > rank(best))) best = id;
    }
    if (best === null) return null;
    left[best]--;
    picks.push(best);
  }
  return picks;
}

// 錬成の結果。使った種類は除いて抽選する
// (同じ種類が返ると「減っただけ」になり、作り替えた意味が無くなるため)。
export function transmuteResult(
  used: ElementId[], rnd: () => number = Math.random,
): ElementId {
  const exclude = new Set<ElementId>(used);
  const pool = ELEMENT_POOL.filter(id => !exclude.has(id));
  const src = pool.length > 0 ? pool : ELEMENT_POOL;
  return src[Math.floor(rnd() * src.length)];
}

// 戦闘報酬の研究P。
//   勝利 … 満額(ボスは+25)
//   敗北 … 最後まで戦った分として勝利報酬の2割(最低2)。ボス加算は付かない
//   撤退 … 0(自分から逃げた場合は成果なし)
export const DEFEAT_RP_RATE = 0.2;

export function battleRP(stage: number, win: boolean, escaped = false): number {
  const base = 6 + 3 * stage;
  if (escaped) return 0;
  if (!win) return Math.max(2, Math.floor(base * DEFEAT_RP_RATE));
  return base + (isBossStage(stage) ? 25 : 0);
}
