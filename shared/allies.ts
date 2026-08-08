// お供AI ― 持ち物と、どう動くかの決まり
//
// ソロで出撃する時、自分が使っていないキャラを1人だけ連れて行ける。
// ソロ戦闘はクライアント側で完結しているので、お供もそこで動く
// (サーバーも通信も要らない。オフラインでも同じように戦う)。
//
// ★ ここは「判断」だけを持ち、画面にも Pixi にも触らない。
//   そうしておくと、戦闘を立ち上げずに検証から直接呼べる
//   (test/ally_check.ts が状況を作って選ばせている)。

import { RECIPES } from './data';
import type { ElementCounts, ElementId } from './types';

// ---- 出すかどうかの旗 ----
//
// false の間は出撃準備に選択欄が出ず、今までどおりのソロになる。
// 交易所のガチャ(GACHA_LIVE)と同じやり方。
export const ALLY_ENABLED = true;

// 解放にかかる研究P(本来の値)。
//
// ★ ステージ到達を条件にしてはいけない。
//   5の倍数はボスで、ボスは共闘部屋からしか挑めない。つまり
//   一人で遊んでいる人の maxStage はステージ5で止まる。
//   「仲間が見つからない人ほど欲しい機能」なのに、仲間が要る条件を
//   付けては本末転倒になる。研究Pなら一人でも必ず届く。
export const ALLY_UNLOCK_RP = 50;

// 体験版の間は無料で解放する。
//
// まだ触ってもらう段階なので、研究Pを貯めるところで止めたくない。
// false にすると ALLY_UNLOCK_RP がかかるようになる ―
// 直すのはこの1行だけでよく、画面の文言も説明書も追随する。
export const ALLY_FREE_NOW = true;

// いま解放にいくらかかるか。画面も説明書も検証も、必ずこれを通す。
export function allyUnlockCost(): number {
  return ALLY_FREE_NOW ? 0 : ALLY_UNLOCK_RP;
}

// お供を連れて行った時の研究Pの倍率。
// 明らかに楽になるので、そのぶん実入りを減らす。
export const ALLY_RP_MUL = 0.8;

// お供の体力とMP。プレイヤー(HP260 / MP150 / 毎秒6)より少し柔らかい。
// 硬いと「連れて行くだけで安全」になり、倒れる緊張感が消える。
export const ALLY_MAX_HP = 180;
export const ALLY_MAX_MP = 130;
export const ALLY_MP_REGEN = 5;

// 敵がお供を狙う割合。0.4 なら5発のうち2発ほどがお供へ向かう。
// 挑発を撃つと、その間だけこの割合が上がる(ALLY_TAUNT_SHARE)。
export const ALLY_HATE_SHARE = 0.4;
export const ALLY_TAUNT_SHARE = 0.85;
export const ALLY_TAUNT_SEC = 6;

// 判断の間合い(秒)。毎フレーム考える必要はないし、
// 間を置いたほうが「考えてから動いた」ように見える。
export const ALLY_THINK_SEC = 0.35;

// ---- 役どころ ----

export type AllyRole =
  | 'heal' | 'shield' | 'ward' | 'taunt' | 'empower' | 'focus' | 'seal' | 'attack';

export interface AllySpellDef {
  recipe: ElementCounts;
  role: AllyRole;
}

export interface AllyDef {
  charId: number;
  note: string;                 // 選択欄に出す一言
  priority: AllyRole[];         // 上から順に見て、条件が合った最初のものを撃つ
  spells: AllySpellDef[];       // 持ち物(すべてノーマル品質・強化なし)
}

// ---- 6人ぶんの持ち物 ----
//
// レシピは既存の系統が成立するものを選んである。図鑑で見た系統が
// そのまま飛んでくるので、プレイヤーは「あれだ」と分かる。
// 得意エレメントを必ず含めてあるので、キャラ補正(+10%)も乗る。
//
// 並び順は shared/characters.ts と同じ。
export const ALLIES: AllyDef[] = [
  {
    charId: 0, // 黒金の魔女(雷)
    note: '雷で手数を稼ぐ。味方を鼓舞して押し切る',
    priority: ['empower', 'focus', 'attack'],
    spells: [
      { recipe: { thunder: 2, wind: 1 }, role: 'attack' },   // 連鎖雷
      { recipe: { wind: 2, thunder: 1 }, role: 'attack' },   // 疾風弾(速い)
      { recipe: { thunder: 2, water: 1 }, role: 'attack' },  // 燃費の良い雷
      { recipe: { earth: 2, light: 1, wind: 1 }, role: 'empower' }, // 鼓舞
    ],
  },
  {
    charId: 1, // 白銀の学士(水)
    note: '水の護りで受け止める。回復もこなす',
    priority: ['heal', 'ward', 'shield', 'attack'],
    spells: [
      { recipe: { water: 2, ice: 1 }, role: 'ward' },            // 護符
      { recipe: { earth: 2, ice: 1, water: 1 }, role: 'shield' }, // 護盾
      { recipe: { light: 3, water: 1 }, role: 'heal' },          // 治癒光
      { recipe: { water: 2, wind: 1 }, role: 'attack' },         // 水流弾
    ],
  },
  {
    charId: 2, // 紅蓮の戦導士(火)
    note: '前へ出て火力で押す。敵を引きつける',
    priority: ['taunt', 'attack'],
    spells: [
      { recipe: { fire: 3, earth: 1 }, role: 'attack' },   // 灼熱弾(大)
      { recipe: { fire: 2, wind: 2 }, role: 'attack' },    // 延焼弾
      { recipe: { fire: 2 }, role: 'attack' },             // 灼熱弾(軽い)
      { recipe: { earth: 2, fire: 1 }, role: 'taunt' },    // 咆哮
    ],
  },
  {
    charId: 3, // 翠緑の薬導士(風)
    note: '風で立て直す。倒れる前に必ず癒す',
    priority: ['heal', 'focus', 'empower', 'attack'],
    spells: [
      { recipe: { light: 3, wind: 1 }, role: 'heal' },           // 治癒光
      { recipe: { ice: 2, light: 1 }, role: 'focus' },           // 瞑想
      { recipe: { earth: 2, light: 1, wind: 1 }, role: 'empower' }, // 鼓舞
      { recipe: { wind: 2 }, role: 'attack' },                   // 疾風弾
    ],
  },
  {
    charId: 4, // 紫紺の導師(土)
    note: '大地で受け止める。敵を一手に引き受ける盾役',
    priority: ['taunt', 'shield', 'empower', 'attack'],
    spells: [
      { recipe: { earth: 2, fire: 1 }, role: 'taunt' },              // 咆哮
      { recipe: { earth: 2, ice: 1 }, role: 'shield' },              // 護盾
      { recipe: { earth: 3 }, role: 'attack' },                      // 地震(全体)
      { recipe: { earth: 2, light: 1, wind: 1 }, role: 'empower' },  // 鼓舞
    ],
  },
  {
    charId: 5, // 蒼氷の術士(氷)
    note: '氷で足を止める。動きを封じて削る',
    priority: ['seal', 'attack'],
    spells: [
      { recipe: { dark: 3, ice: 1 }, role: 'seal' },              // 封印
      { recipe: { ice: 2, water: 1 }, role: 'attack' },           // 凍結槍
      { recipe: { dark: 2, water: 1, ice: 1 }, role: 'attack' },  // 腐蝕弾
      { recipe: { ice: 2 }, role: 'attack' },                     // 氷弾(軽い)
    ],
  },
];

export function allyDefFor(charId: number): AllyDef | null {
  return ALLIES.find(a => a.charId === charId) ?? null;
}

// ---- 今どういう状況か ----
//
// 戦闘側が毎回これを詰めて渡す。お供はこれだけを見て決める。
export interface AllySight {
  myHpPct: number;        // お供自身の残り(0〜1)
  playerHpPct: number;    // プレイヤーの残り(0〜1)
  myMpPct: number;        // お供のMP(0〜1)
  enemiesAlive: number;
  shielded: boolean;      // お供が護盾を張っているか
  warded: boolean;        // 属性耐性が乗っているか
  empowered: boolean;     // 与ダメ上昇が乗っているか
  taunting: boolean;      // 挑発が効いている最中か
  // 敵の弱点(◎○)を突ける属性。無ければ null。
  weakAttr: ElementId | null;
}

// 役どころごとの「撃つべき状況か」。
//
// ここに条件をまとめてあるので、キャラごとの個性は
// 「どの役どころを持っているか」と「priority の並び」だけで出る。
export function roleWanted(role: AllyRole, s: AllySight): boolean {
  switch (role) {
    case 'heal':
      // どちらかが4割5分を切ったら。自分の分も見るので、
      // 回復役は自分が倒れる前に自分を癒す。
      return Math.min(s.myHpPct, s.playerHpPct) <= 0.45;
    case 'shield':
      return !s.shielded && s.enemiesAlive >= 2;
    case 'ward':
      return !s.warded && s.enemiesAlive >= 3;
    case 'taunt':
      // 盾役が意味を持つのは、敵が複数いてプレイヤーが削られている時。
      // 敵1体なら引き受けても得が無い。
      return !s.taunting && s.enemiesAlive >= 2 && s.playerHpPct <= 0.7;
    case 'empower':
      return !s.empowered && s.enemiesAlive >= 2;
    case 'focus':
      // 息切れしかけたら整える。ここが無いと回復役はすぐ棒立ちになる。
      return s.myMpPct <= 0.3;
    case 'seal':
      return s.enemiesAlive >= 1;
    case 'attack':
      return true;
    default:
      return false;
  }
}

// ---- どれを撃つか ----
//
// usable[i] = その持ち物がいま撃てるか(MPと再使用時間は戦闘側が見る)。
// 戻り値は持ち物の番号。撃てるものが無ければ -1。
export function chooseAllySpell(
  def: AllyDef, s: AllySight, usable: boolean[],
): number {
  for (const role of def.priority) {
    if (!roleWanted(role, s)) continue;
    const i = pickForRole(def, role, s, usable);
    if (i >= 0) return i;
  }
  // priority に無い役どころしか持っていない時の受け皿。
  // 何も撃たずに突っ立っているより、撃てるものを撃つ。
  for (let i = 0; i < def.spells.length; i++) {
    if (usable[i]) return i;
  }
  return -1;
}

function pickForRole(
  def: AllyDef, role: AllyRole, s: AllySight, usable: boolean[],
): number {
  const cands: number[] = [];
  for (let i = 0; i < def.spells.length; i++) {
    if (usable[i] && def.spells[i].role === role) cands.push(i);
  }
  if (cands.length === 0) return -1;
  if (role !== 'attack' || !s.weakAttr) return cands[0];

  // 攻撃は弱点を突けるものを優先する。
  // 同じ属性が複数あれば、先に書いてある(=強い)ほうを選ぶ。
  const weak = cands.find(i => (def.spells[i].recipe[s.weakAttr!] ?? 0) > 0);
  return weak !== undefined ? weak : cands[0];
}

// 持ち物のレシピが、狙った系統をちゃんと成立させているか。
// 検証で使う ― 表を書き換えた時に、系統から外れていないかを見張る。
export function recipeMatches(recipe: ElementCounts, recipeId: string): boolean {
  const r = RECIPES.find(x => x.id === recipeId);
  return r ? r.check(recipe) : false;
}
