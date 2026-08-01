// 共通型定義

export type ElementId =
  | 'fire' | 'water' | 'wind' | 'earth'
  | 'thunder' | 'ice' | 'light' | 'dark';

export type ElementCounts = Partial<Record<ElementId, number>>;

export type SpellKind = 'attack' | 'shield' | 'heal' | 'taunt' | 'ward';

// 調合時にごく稀に生まれる品質
export type Rarity = 'normal' | 'rare' | 'epic' | 'legend';

// 調合で決まる魔法の性能
export interface SpellStats {
  kind: SpellKind;    // attack=攻撃 / shield=護盾 / heal=回復 / taunt=挑発
  barrier: number;    // 護盾耐久(kind=shield)
  healPower: number;  // 回復量(kind=heal)
  hateGain: number;   // ヘイト増加量(kind=taunt)
  targetAll: boolean; // true=パーティ全体対象(shield/heal)
  quake: boolean;     // true=地震(弾を飛ばさず敵全体に威力75%・画面が揺れる)
  wardPct: number;    // 属性耐性(%)。kind=ward で使用
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
}

export interface GameState {
  version: number;
  nickname: string;        // 一度決めたら初期化まで変更不可
  researchP: number;
  inventory: Record<ElementId, number>;
  spells: Spell[];
  equipped: string[];      // 装備中の魔法ID(最大4)
  discovered: string[];    // 発見済みレシピID
  slots: number;           // 調合スロット数(3〜5)
  maxStage: number;        // 挑戦可能ステージ
  bestStage: number;       // 最高クリアステージ
  bossCleared: number[];   // 撃破したボスステージ(共闘でのみ撃破可能)
  sortByPower: boolean;    // 魔導書を魔導値順に並べるか
}

export interface BattleResult {
  win: boolean;
  escaped: boolean;
  stage: number;
  drops: ElementId[];
  rp: number;
}
