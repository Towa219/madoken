import {
  ELEMENTS, ELEMENT_ORDER, PLAYER_MAX_HP, PLAYER_MP_REGEN, RARITIES, RECIPES,
  REVIVE_HP_RATE, REVIVE_MANA_FLOOR,
} from './data';
import type { RecipeDef } from './data';
import { CHAR_POWER_BONUS, characterElement } from './characters';
import type { ElementCounts, ElementId, Rarity, SpellKind, SpellStats } from './types';

// 属性ごとの命名用一文字
// 魔法名で使う属性の一文字。素材庫・相性・性能表示と必ず同じ字を使うこと。
// 以前は火を「炎」、土を「地」と書き分けていたため、素材庫では「火」なのに
// 魔法名の構成タグは〈炎2風2〉となり、同じものが二通りの字で出ていた。
const ATTR_CHAR: Record<ElementId, string> = Object.fromEntries(
  ELEMENT_ORDER.map(id => [id, ELEMENTS[id].name]),
) as Record<ElementId, string>;

export interface CraftResult {
  stats: SpellStats;
  matched: RecipeDef[];
  autoName: string;
}

// エレメント構成から魔法の性能を算出する(調合の核)
export function computeSpell(counts: ElementCounts): CraftResult {
  const s: SpellStats = {
    kind: 'attack', barrier: 0, healPower: 0, hateGain: 0, targetAll: false,
    quake: false, wardPct: 0, hpBoost: 0, sealTime: 0, coolTime: 0, atkBoost: 0,
    mpRegenBonus: 0,
    dotDps: 0, dotTime: 0, dotStrong: false,
    power: 10, castTime: 1.3, manaCost: 20, projSpeed: 260,
    radius: 0, pierce: false, chain: 0, critRate: 5,
    lifesteal: 0, freeze: 0, slow: 0, selfDamage: 0,
    attr: 'fire',
  };

  const c = (id: ElementId) => counts[id] ?? 0;

  // 雷と風は以前まったく威力に寄与せず、雷3が威力10・会心29%で魔導値60という
  // 全属性で最低の魔法になっていた。元の威力が10では会心が上がっても意味がない。
  // 雷は「速くて当たれば大きい」、風は「軽くて速い」という役割を保ったまま、
  // 威力の下地を持たせてある。
  // 水と氷は威力の下地が低すぎた。単一3個で比べると
  // 水92・氷110 に対し、闇291・火273 と3倍近い開きがあり、
  // 「燃費が良い」「遅くする」という持ち味の前に、そもそも選ばれなかった。
  // 水 +2→+3 / 氷 +3→+4 に上げて底を持ち上げる。
  // (+4/+5 まで上げると回復と瞑想が魔導値の上限を超えた)
  // (ELEMENTS の desc も同じ数字にすること。片方だけ直すと説明と食い違う)
  s.power += 8 * c('fire') + 3 * c('water') + 5 * c('earth')
           + 4 * c('ice') + 3 * c('light') + 12 * c('dark')
           + 7 * c('thunder') + 3 * c('wind');
  s.manaCost += 6 * c('fire') - 4 * c('water') + 3 * c('earth')
              + 6 * c('dark') + 4 * c('thunder') + 2 * c('light');
  s.castTime -= 0.2 * c('wind');
  s.projSpeed += 70 * c('wind') + 130 * c('thunder');
  s.critRate += 8 * c('thunder');
  s.slow += 14 * c('ice');
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
  s.castTime = Math.max(0.35, Math.round(s.castTime * 100) / 100);
  s.manaCost = Math.max(4, Math.round(s.manaCost));
  s.power = Math.max(1, Math.round(s.power));
  s.projSpeed = Math.round(s.projSpeed);
  s.critRate = Math.min(80, Math.round(s.critRate));

  // 防御・支援系の性能は威力から換算
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 2.2 + 14);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);
  if (s.kind === 'focus') s.mpRegenBonus = mpRegenBonusOf(s);
  // ここは調合台のプレビューでも使う。1つでも抜けると
  // 「敵全体を0.0秒 行動不能」のように効果0で表示され、魔導値も1になる。
  // finalStats と同じ顔ぶれを揃えること。
  if (s.kind === 'ward') s.wardPct = wardPctOf(s);
  if (s.kind === 'vigor') s.hpBoost = hpBoostOf(s);
  if (s.kind === 'seal') { s.sealTime = sealTimeOf(s); s.coolTime = sealCoolOf(0); }
  if (s.kind === 'empower') s.atkBoost = atkBoostOf(s);
  // 蘇生は消費MPに下限を置く。光は消費を下げる性質があるので、
  // 素の計算だと32まで落ちて「一番強い効果が一番安い」ことになる。
  if (s.kind === 'revive') s.manaCost = Math.max(s.manaCost, REVIVE_MANA_FLOOR);
  if (s.kind === 'heal') s.manaCost = Math.max(s.manaCost, healManaFloor(s));
  if (s.dotTime > 0) s.dotDps = dotDpsOf(s);
  // 再使用時間も持たせておく。finalStats 側は強化ぶんを掛けて丸めるので、
  // ここで丸めておかないと強化前でも小数の分だけ魔導値がずれる。
  if (s.kind !== 'seal') s.coolTime = Math.round(baseCooldownOf(s) * 10) / 10;

  // 自動命名: 主属性接頭辞 + 系統名 + 威力階級 + 構成タグ
  // 構成タグ〈火2風〉はレシピの完全な符号なので、
  // エレメントが1つでも違えば必ず別の名前になる。
  // 例: 火3 →「炎の爆裂弾・改〈火3〉」 / 火2+風1 →「炎の魔弾〈火2風〉」
  const noun = matched.length > 0 ? matched[matched.length - 1].spellNoun : '魔弾';

  // 属性の一文字が系統名にも入っている場合は接頭を付けない。
  // 付けると「雷の連鎖雷」「光の治癒光」のように同じ漢字が二度出て見栄えが悪い。
  // ここで弾いておけば、今後どんな系統名を足しても重複しない。
  const attrChar = ATTR_CHAR[s.attr];
  const prefix = noun.includes(attrChar) ? '' : `${attrChar}の`;

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

// レシピ(エレメント構成)が完全一致か。
// 「同じ魔法」の物差し。調合の強化判定とガチャの重複判定で必ず同じ物を使う。
export function recipesEqual(a: ElementCounts, b: ElementCounts): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ElementId>;
  for (const id of ids) {
    if ((a[id] ?? 0) !== (b[id] ?? 0)) return false;
  }
  return true;
}

// 授ける魔法の中身をくじで決める。系統は運任せ。
//
// 系統をただ1つ選んで bestCompositionFor に渡すだけでは駄目で、
// 素材の数が足りない系統を引くと null が返り、何も授からずに終わる
// (ガチャでチケットだけ減る不具合になった)。作れる系統に当たるまで
// 順に試す。作れるものが1つも無いことは、素材2個で成立する系統が
// ある限り起こらない。
export function randomComposition(
  maxElements: number, rnd: () => number = Math.random,
): { recipeId: string; counts: ElementCounts } | null {
  const order = RECIPES.map(r => r.id);
  for (let i = order.length - 1; i > 0; i--) {   // 偏りの出ない混ぜ方
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const recipeId of order) {
    const counts = bestCompositionFor(recipeId, maxElements);
    if (counts) return { recipeId, counts };
  }
  return null;
}

// ===== 強化(同一レシピの再調合) =====

export const ENHANCE_MAX = 9;

// 強化(1段階ごとに威力+8%・詠唱-2%)と品質倍率をまとめて適用する
// 得意エレメントによる威力の上乗せ。
//
// charId を渡さなければ何も掛からない(素の性能)。魔法そのものの強さを
// 比べたい場面 ― 調合の見積もりや図鑑 ― では渡さない。
export function charPowerMul(counts: ElementCounts, charId: unknown): number {
  if (charId === null || charId === undefined) return 1;
  const el = characterElement(charId);
  return (counts[el] ?? 0) > 0 ? 1 + CHAR_POWER_BONUS : 1;
}

export function finalStats(
  counts: ElementCounts, level: number, rarity: Rarity = 'normal',
  charId: unknown = null,
): SpellStats {
  const base = computeSpell(counts).stats;
  const L = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(level || 0)));
  const rDef = RARITIES[rarity] ?? RARITIES.normal;
  const s: SpellStats = { ...base };

  // 得意エレメントを含む魔法は威力が上がる。
  // ここに掛けると、護盾の耐久や回復量といった威力から出る値も一緒に上がる。
  const mul = (1 + 0.08 * L) * rDef.mul * charPowerMul(counts, charId);
  s.power = Math.max(1, Math.round(base.power * mul));
  s.castTime = Math.max(0.35, Math.round(base.castTime * (1 - 0.02 * L) * 100) / 100);
  s.critRate = Math.min(80, Math.round(base.critRate + (rDef.mul - 1) * 20));

  // 強化すると再使用時間と消費MPも少しずつ下がる。
  // 威力だけが伸びると「重いけど強い」一辺倒になるので、手数も軽くする。
  // 下げ幅は控えめ(1段階1.5%、+9で13.5%)。大きくすると強化した魔法だけで
  // 撃ち続けられてしまい、MPのやりくりが要らなくなる。
  const ease = 1 - ENHANCE_EASE_PER_LEVEL * L;
  s.manaCost = Math.max(4, Math.round(base.manaCost * ease));
  // 封印は「1段階につき1秒」という別の決まりがあるので、そちらに任せる。
  if (s.kind !== 'seal') {
    s.coolTime = Math.round(baseCooldownOf(s) * ease * 10) / 10;
  }

  // 派生値は最終威力から再計算
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  // 回復量は下駄の部分にも強化倍率を掛ける。掛けないと、強化しても
  // 回復量の伸びだけが鈍る(威力は1.72倍になるのに回復量は1.57倍にしかならない)。
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 2.2 + 14 * mul);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);
  if (s.kind === 'ward') s.wardPct = wardPctOf(s);
  if (s.kind === 'vigor') s.hpBoost = hpBoostOf(s);
  // 封印は強化で「止める時間が延び、再使用が縮む」
  if (s.kind === 'seal') { s.sealTime = sealTimeAt(base, L); s.coolTime = sealCoolOf(L); }
  if (s.kind === 'empower') s.atkBoost = atkBoostOf(s);
  if (s.kind === 'focus') s.mpRegenBonus = mpRegenBonusOf(s);
  if (s.kind === 'revive') s.manaCost = Math.max(s.manaCost, REVIVE_MANA_FLOOR);
  // 回復の下限MPは「品質ぶんを除いた回復量」から決める。
  //
  // 最終回復量から決めていた頃は、品質で回復量が増えたぶんだけMPも増えた。
  // 攻撃魔法は品質が上がってもMPは据え置き(=同じMPで倍の威力)なのに、
  // 回復だけ効率が変わらず、1回が重くなるだけになっていた。
  // レジェンドの慈雨(光4水2)は 38→76 とMPが倍になり、最大MP150の半分を
  // 1回で持っていっていた。「上位品質なのにMPが多すぎる」の正体はこれ。
  //
  // 回復量は品質倍率に比例するので、割り戻せば品質ぶんだけを外せる。
  // 強化ぶんは今までどおり下限に効かせる ― 強化まで外すと、自然回復の
  // MPだけで撃ち続けられるようになる(test/heal_ratio_calc.ts が見張っている)。
  if (s.kind === 'heal') {
    s.manaCost = Math.max(
      s.manaCost, Math.round(healManaFloor(s) / rDef.mul * ease));
  }
  if (s.dotTime > 0) s.dotDps = dotDpsOf(s);
  return s;
}

// 与ダメージ上昇(%)。上限60%、全体版は7割
export function atkBoostOf(s: SpellStats): number {
  const base = Math.min(60, 15 + s.power / 4);
  return Math.round(s.targetAll ? base * 0.7 : base);
}

// 回復魔法の消費MPの下限。
//
// 水はエレメント1個につき消費MPを4下げ、さらに静水系(水×2)が5下げる。
// そのため水を盛るほどMPが際限なく下がり、「光3+水2」で13MPで46回復まで伸びていた。
// これはMPの自然回復(毎秒3)だけで撃ち続けられてしまい、実質不死身になる。
// 回復量に対する下限を設けて、MP1あたりの回復量に上限をかける。
// 消費MPは回復量の50%以上(= 最大 約2.0 HP/MP)。
// 光3(26MP)や光3+水1(22MP)といった素直な構成は元々これを上回っているため、
// 影響を受けるのは水を盛ってMPを削り込んだ構成だけ。
export const HEAL_MP_RATIO = 0.5;

export function healManaFloor(s: SpellStats): number {
  return Math.round(s.healPower * HEAL_MP_RATIO);
}

// MP自然回復の基礎(毎秒)。data.ts の値をそのまま使う。
// 別々に書くと、瞑想の評価だけが実態と食い違う。
export const BASE_MP_REGEN = PLAYER_MP_REGEN;

// MP自然回復の上乗せ(毎秒)。基礎の自然回復は毎秒3なので、+3で倍になる。
// 上限6(毎秒9=3倍)。全体版は7割。
// 瞑想系(と共鳴系)のMP回復量にかかる倍率。
//
// 2026-08-11に 1.0 → 1.5 へ。長期戦を支える系統なのに、
// 上限が毎秒6(自然回復3の2倍)では撃ち続けるほどの差にならなかった。
// 上限も一緒に上がる(6 → 9)ようにしてある ―
// ここだけ据え置くと、威力を上げても頭打ちのままで倍率の意味が消える。
export const FOCUS_REGEN_MUL = 1.5;

export function mpRegenBonusOf(s: SpellStats): number {
  const base = Math.min(6, 1.5 + s.power / 16) * FOCUS_REGEN_MUL;
  return Math.round((s.targetAll ? base * 0.7 : base) * 10) / 10;
}

// 継続ダメージ(毎秒)。延焼系は腐蝕系より短いぶん強い。
export function dotDpsOf(s: SpellStats): number {
  return Math.max(1, Math.round(s.power * (s.dotStrong ? 0.28 : 0.18)));
}

// 行動不能にする秒数(威力から換算・上限6秒)
// 行動不能の秒数。強化していない状態(強化前の威力)から出す。
// 強化ぶんは sealTimeAt で足す。ここに強化後の威力を渡すと二重に効いてしまう。
export function sealTimeOf(s: SpellStats): number {
  return Math.round(Math.min(13, 1.2 + s.power / 5.2) * 10) / 10;
}

// 強化1段階ごとに、再使用時間と消費MPが下がる割合。
export const ENHANCE_EASE_PER_LEVEL = 0.015;

// 強化1段階ごとに行動不能は1秒延び、再使用は1秒縮む。
// 端数で刻むと「+1で0.3秒」のように伸びが分からないので、きっちり1秒ずつにしてある。
export const SEAL_TIME_PER_LEVEL = 1;
export const SEAL_COOL_PER_LEVEL = 1;

export function sealTimeAt(base: SpellStats, level: number): number {
  const L = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(level || 0)));
  return Math.round((sealTimeOf(base) + SEAL_TIME_PER_LEVEL * L) * 10) / 10;
}

// 封印が相手にどれだけ効くか(0〜1.5)。相手の属性相性で決まる。
//
// 攻撃魔法と同じで、闇に強い相手ほど封印も効きにくい。
// ✕(ほぼ無効)の相手には一切効かない = レジストされる。
// ソロ・共闘・決闘のどれでも同じ規則にするため、ここに1つだけ置く。
export function sealResistMul(grade: number): number {
  if (grade <= -2) return 0;      // レジスト(まったく効かない)
  if (grade === -1) return 0.5;   // 耐性: 半分の時間しか止まらない
  return 1;
}

// 決闘では相手は敵ではなく研究者なので、相性の代わりに護符(属性耐性)で判定する。
// 耐性60%以上でレジスト、それ未満は耐性のぶんだけ短くなる。
export function sealWardMul(wardPct: number): number {
  const p = Math.max(0, Math.min(100, wardPct));
  if (p >= 60) return 0;
  return Math.round((1 - p / 60) * 100) / 100;
}

// 封印の再使用時間(秒)。強化するほど短くなる。
//
// 敵全体を止める効果は、止めている時間の割合がそのまま強さになる。
// 10秒止めるのに再使用が16秒のままだと戦闘時間の6割を止めることになり、
// 封印だけが突出してしまう。長く止める代わりに間隔も長い「切り札」にした。
export function sealCoolOf(level: number): number {
  const L = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(level || 0)));
  return Math.round((40 - SEAL_COOL_PER_LEVEL * L) * 10) / 10;
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
  // 魔法が自前の再使用時間を持っていればそれを使う(強化で縮むもの)
  if (s.coolTime > 0) return s.coolTime;
  return baseCooldownOf(s);
}

// 種類ごとの既定の再使用時間(強化前)。
// spellCooldown と違い coolTime を見ないので、強化で縮める元の値として使える。
export function baseCooldownOf(s: SpellStats): number {
  if (s.kind === 'shield') return 6;
  if (s.kind === 'heal') return 5;
  if (s.kind === 'taunt') return 8;
  if (s.kind === 'ward') return 10;
  if (s.kind === 'vigor') return 14;
  if (s.kind === 'seal') return 16;
  // 蘇生はいちばん長い。連発できると「倒れる」ことの重みが消える
  if (s.kind === 'revive') return 30;
  if (s.kind === 'empower') return 14;
  if (s.kind === 'focus') return 14;
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
    atkBoost: n(raw?.atkBoost), mpRegenBonus: n(raw?.mpRegenBonus),
    coolTime: n(raw?.coolTime),
    dotDps: n(raw?.dotDps), dotTime: n(raw?.dotTime),
    dotStrong: Boolean(raw?.dotStrong),
    power: n(raw?.power), castTime: n(raw?.castTime), manaCost: n(raw?.manaCost),
    projSpeed: n(raw?.projSpeed), radius: n(raw?.radius), chain: n(raw?.chain),
    critRate: n(raw?.critRate), lifesteal: n(raw?.lifesteal), freeze: n(raw?.freeze),
    slow: n(raw?.slow), selfDamage: n(raw?.selfDamage),
  };
}

// 支援・防御の効果時間(秒)。battle.ts で実際に設定している値と揃えること。
// ここがずれると、強さの評価だけが実態と食い違う。
const EFFECT_TIME: Partial<Record<SpellKind, number>> = {
  shield: 10, ward: 12, vigor: 25, empower: 20, focus: 20,
};

// 攻撃魔法は「12 × 実質DPS」で評価している。
// 支援・防御もこの物差しに載せないと、割合で効くもの(与ダメ上昇・耐性)が
// 不当に安く見積もられる。以前は闘気(全員の与ダメ+31%を維持)が
// 攻撃1本の1/8という評価になっていた。
const REF_DPS = 34;   // 良い攻撃魔法1本ぶんのDPS(魔導値およそ400に相当)
const PARTY = 1.8;    // 全体対象の割り増し(共闘は2人以上・単独もあるので控えめ)

// その効果を戦闘中どれだけ張り続けられるか(0〜1)。
// 効果時間が再使用時間より長ければ常時維持できる。
function upTime(s: SpellStats): number {
  const dur = EFFECT_TIME[s.kind];
  if (!dur) return 1;
  return Math.min(1, dur / (s.castTime + spellCooldown(s)));
}

export function spellMagicValue(raw: SpellStats): number {
  const s = normalizeStats(raw);
  const cycle = s.castTime + spellCooldown(s) * 0.6; // 1発に要する実時間
  const all = s.targetAll ? PARTY : 1;
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
    // 1秒あたりに肩代わりできるダメージ量
    v = (s.barrier * all / cycle) * 15;
  } else if (s.kind === 'heal') {
    // 最大HPを超えて回復した分は捨てられる。1回で全快してしまう回復量から先は
    // ほとんど価値が増えないので、そこから上は伸びを鈍らせる。
    // これが無いと、消費MPを気にせず回復量だけ大きくした構成が突出する。
    const cap = PLAYER_MAX_HP * 0.5;
    const useful = s.healPower <= cap ? s.healPower : cap + (s.healPower - cap) * 0.35;
    v = (useful * all / cycle) * 15;
  } else if (s.kind === 'ward') {
    // 被ダメを wardPct% 減らす。全属性(=どの敵にも効く)と単属性で価値が大きく違う。
    v = REF_DPS * (s.wardPct / 100) * 12 * upTime(s) * (s.targetAll ? 3.1 : 1.0);
  } else if (s.kind === 'vigor') {
    // 最大HP上昇 + 同量の即時回復。1秒あたりに供給するHPとして数える。
    v = (s.hpBoost * 2 * all / (s.castTime + spellCooldown(s))) * 27 * upTime(s);
  } else if (s.kind === 'revive') {
    // 倒れた人を戻す = その人がこの先出すはずだった働きを丸ごと取り戻す。
    // 味方1人ぶんの基準DPSを、復帰後に出せる時間ぶん取り返したと見なす。
    // (誰も倒れていなければ空振りなので、実際の価値は場面による)
    v = REF_DPS * 12 * 1.8;
  } else if (s.kind === 'seal') {
    // 敵全体の行動を止める = その割合ぶん敵のDPSを消している
    const stop = Math.min(0.85, s.sealTime / (s.castTime + spellCooldown(s)));
    v = REF_DPS * stop * 12 * 3.8;
  } else if (s.kind === 'empower') {
    // 与ダメ+atkBoost%。維持できるので、そのまま基準DPSへの上乗せとみなす。
    v = REF_DPS * (s.atkBoost / 100) * 12 * upTime(s) * all * 3.3;
  } else if (s.kind === 'focus') {
    // MP回復の上乗せ。MPが尽きて詠唱できない時間が減る = そのぶん手数が増える。
    v = REF_DPS * (s.mpRegenBonus / BASE_MP_REGEN) * 12 * upTime(s) * all * 1.5;
  } else {
    // 挑発: 敵の狙いを引き受ける。仲間が殴られない時間を作る役目。
    // 味方の被弾を丸ごと肩代わりするので、他の支援と同じ水準まで見てよい。
    v = (s.hateGain / cycle) * 1.4 * 3.0 + 70;
  }

  // MP効率。回復魔法は「回復量の半分」を消費MPの下限にしているので、
  // 強化して回復量が増えると消費MPも必ず増える。そのまま減点すると、
  // 強化しても魔導値の伸びだけが鈍る(回復1.50倍に対し攻撃1.97倍だった)。
  // 回復については下限を超えた分だけを無駄と見なす。
  const mpForEff = s.kind === 'heal'
    ? Math.max(4, s.manaCost - Math.min(healManaFloor(s), s.manaCost) + 18)
    : s.manaCost;
  v *= 1 + Math.max(-0.25, (18 - mpForEff) / 120);
  v -= s.selfDamage * 1.8;
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.round(v));
}

// 装備中の魔法の魔導値合計 = 戦闘力
export function combatPower(spells: { stats: SpellStats }[]): number {
  return spells.reduce((sum, sp) => sum + spellMagicValue(sp.stats), 0);
}

// オンラインランキングと同じ数え方の魔導値合計。
//
// 戦闘力(combatPower)との違いは「どれを数えるか」。
//   戦闘力     … いま装備している魔法
//   ランキング … 持っている魔法から、装備できる本数だけ強い順に
// 装備の入れ替えで順位が動かないよう、ランキング側はこの数え方をしている
// (server/ranking.ts の magicRankScore と同じ考え方)。
//
// お供の強さもこちらに合わせる。「装備を外したらお供まで弱くなった」では
// 理由が分かりにくいし、順位に出ている数字と一致していたほうが説明しやすい。
export function magicTotal(spells: { stats: SpellStats }[], topN: number): number {
  return spells
    .map(sp => spellMagicValue(sp.stats))
    .sort((a, b) => b - a)
    .slice(0, Math.max(1, Math.floor(topN)))
    .reduce((sum, v) => sum + v, 0);
}

// 性能の表示用テキスト(研究室・戦闘の両方で使用)
export function statsSummary(s: SpellStats): string {
  if (s.kind === 'shield') {
    const head = s.targetAll
      ? `【全体護盾】全員に耐久${Math.round(s.barrier * 0.6)}`
      : `【護盾】耐久${s.barrier}`;
    const parts = [
      head, '持続10秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
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
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
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
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'focus') {
    const parts = [
      s.targetAll
        ? `【瞑想】全員のMP回復 毎秒+${s.mpRegenBonus.toFixed(1)}`
        : `【瞑想】MP回復 毎秒+${s.mpRegenBonus.toFixed(1)}(通常は毎秒${BASE_MP_REGEN})`,
      '20秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'revive') {
    const parts = [
      `【蘇生】倒れた仲間を全員よみがえらせる(最大HPの${Math.round(REVIVE_HP_RATE * 100)}%)`,
      `倒れている人がいなければ全員を回復(各自${Math.round(PLAYER_MAX_HP * REVIVE_HP_RATE)})`,
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`,
      `再使用${spellCooldown(s).toFixed(1)}秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'seal') {
    const parts = [
      `【封印】敵全体を${s.sealTime.toFixed(1)}秒 行動不能`,
      `${ELEMENTS[s.attr].name}耐性△の敵には半減・✕の敵にはレジスト`,
      '決闘では相手の詠唱を封じる(護符で軽減される)',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`,
      `再使用${spellCooldown(s).toFixed(1)}秒`,
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
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
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
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    return parts.join(' / ');
  }
  if (s.kind === 'taunt') {
    const parts = [
      `【挑発】ヘイト+${s.hateGain}`, '敵の狙いを自分へ',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
    ];
    if (s.selfDamage > 0) parts.push(`自傷${s.selfDamage}`);
    parts.push(`属性:${ELEMENTS[s.attr].name}`);
    return parts.join(' / ');
  }
  const parts = s.quake
    ? [
        `威力${s.power}`, '全体攻撃(地震・威力75%)',
        `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, `再使用${spellCooldown(s).toFixed(1)}秒`,
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
