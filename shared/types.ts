// 共通型定義

export type ElementId =
  | 'fire' | 'water' | 'wind' | 'earth'
  | 'thunder' | 'ice' | 'light' | 'dark';

export type ElementCounts = Partial<Record<ElementId, number>>;

export type SpellKind =
  | 'attack' | 'shield' | 'heal' | 'taunt' | 'ward' | 'vigor' | 'seal' | 'empower'
  | 'focus';

// 調合時にごく稀に生まれる品質
export type Rarity = 'normal' | 'rare' | 'epic' | 'legend';

// 魔導書の並び順。
//   use   = 装備頻度順(よく使うものが上。既定)
//   power = 魔導値順
//   order = 取得順(調合した順)
export type SpellSort = 'use' | 'power' | 'order';

// 調合で決まる魔法の性能
export interface SpellStats {
  kind: SpellKind;    // attack=攻撃 / shield=護盾 / heal=回復 / taunt=挑発
  barrier: number;    // 護盾耐久(kind=shield)
  healPower: number;  // 回復量(kind=heal)
  hateGain: number;   // ヘイト増加量(kind=taunt)
  targetAll: boolean; // true=パーティ全体対象(shield/heal)
  quake: boolean;     // true=地震(弾を飛ばさず敵全体に威力75%・画面が揺れる)
  wardPct: number;    // 属性耐性(%)。kind=ward で使用
  hpBoost: number;    // 最大HP上昇量。kind=vigor で使用
  sealTime: number;   // 行動不能にする秒数。kind=seal で使用
  coolTime: number;   // 再使用までの秒数。0なら種類ごとの既定値を使う
  atkBoost: number;   // 与ダメージ上昇(%)。kind=empower で使用
  mpRegenBonus: number; // MP自然回復の上乗せ(毎秒)。kind=focus で使用
  dotDps: number;     // 継続ダメージ(毎秒)。威力から算出する
  dotStrong: boolean; // 継続ダメージが強い型か(延焼系)。dotDpsの倍率が変わる
  dotTime: number;    // 継続ダメージの持続秒数
  power: number;      // 威力
  castTime: number;   // 詠唱時間(秒)
  manaCost: number;   // 消費MP
  projSpeed: number;  // 弾速(px/秒)
  radius: number;     // 爆発半径(px, 0=単体)
  pierce: boolean;    // 貫通
  chain: number;      // 連鎖数
  critRate: number;   // 会心率(%)
  lifesteal: number;  // 与ダメージ吸収(%)
  freeze: number;     // 命中時凍結(秒)
  slow: number;       // 命中時鈍化(%)
  selfDamage: number; // 詠唱完了時の自傷
  attr: ElementId;    // 属性(最多エレメント)
}

export interface Spell {
  id: string;
  name: string;
  recipe: ElementCounts;   // 使用したエレメント
  stats: SpellStats;       // 強化適用済みの性能
  discoveries: string[];   // 成立した系統レシピID
  level: number;           // 強化レベル(同一レシピ再調合で+1、最大9)
  rarity: Rarity;          // 品質
  equipCount: number;      // 装備した回数。魔導書の「装備頻度順」に使う
}

// お気に入りの装備セット。
// ids の並びがそのまま装備の順=戦闘のキー1〜6になるので、順番も含めて覚える。
export interface Loadout {
  name: string;
  ids: string[];
}

export interface GameState {
  version: number;
  nickname: string;        // 一度決めたら初期化まで変更不可
  nickToken: string;       // ニックネームの所有者を示す秘密ID(初期化で解放に使う)
  charId: number;          // 選んだキャラクター(得意エレメントの魔法が強くなる)
  researchP: number;
  inventory: Record<ElementId, number>;
  spells: Spell[];
  equipped: string[];      // 装備中の魔法ID(最大4)
  discovered: string[];    // 発見済みレシピID
  slots: number;           // 調合スロット数(2〜MAX_SLOTS)
  maxStage: number;        // 挑戦可能ステージ
  bestStage: number;       // 最高クリアステージ
  bossCleared: number[];   // 撃破したボスステージ(共闘でのみ撃破可能)
  sortMode: SpellSort;     // 魔導書の並び順
  loadouts: Loadout[];     // お気に入りの装備セット(LOADOUT_COUNT個で固定)
  sortByPower?: boolean;   // 旧版の並び順(魔導値順かどうか)。読み込み時の変換にだけ使う
  codexRewarded: boolean;  // 発見図鑑コンプリート報酬(エピック)を受け取ったか
  tickets: number;         // ガチャチケット(1日1枚のログインボーナス)
  lastBonusDate: string;   // 最後にボーナスを配った日(YYYY-MM-DD)
  // 最深部の報酬を受け取ったボスステージ(BOSS_REWARDS を参照)
  bossRewarded: number[];
  // 旧い形式。ステージ50の報酬だけを持っていた。
  // 読み込み時に bossRewarded へ移すが、古い端末と行き来しても
  // 二重取得にならないよう書き込みも続ける。
  legendRewarded: boolean;
}

export interface BattleResult {
  win: boolean;
  escaped: boolean;
  stage: number;
  drops: ElementId[];
  rp: number;
}
