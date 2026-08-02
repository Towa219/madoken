import { ELEMENTS, ELEMENT_ORDER, PLAYER_MP_REGEN, RARITIES, RECIPES } from './data';
import type { RecipeDef } from './data';
import type { ElementCounts, ElementId, Rarity, SpellKind, SpellStats } from './types';

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
  s.power += 8 * c('fire') + 2 * c('water') + 5 * c('earth')
           + 3 * c('ice') + 2 * c('light') + 12 * c('dark')
           + 7 * c('thunder') + 3 * c('wind');
  s.manaCost += 6 * c('fire') - 4 * c('water') + 3 * c('earth')
              + 6 * c('dark') + 4 * c('thunder') + 2 * c('light');
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
  s.castTime = Math.max(0.35, Math.round(s.castTime * 100) / 100);
  s.manaCost = Math.max(4, Math.round(s.manaCost));
  s.power = Math.max(1, Math.round(s.power));
  s.projSpeed = Math.round(s.projSpeed);
  s.critRate = Math.min(80, Math.round(s.critRate));

  // 防御・支援系の性能は威力から換算
  if (s.kind === 'shield') s.barrier = Math.round(s.power * 2.2);
  if (s.kind === 'heal') s.healPower = Math.round(s.power * 1.8 + 10);
  if (s.kind === 'taunt') s.hateGain = Math.round(s.power * 10);
  if (s.kind === 'focus') s.mpRegenBonus = mpRegenBonusOf(s);
  // ここは調合台のプレビューでも使う。1つでも抜けると
  // 「敵全体を0.0秒 行動不能」のように効果0で表示され、魔導値も1になる。
  // finalStats と同じ顔ぶれを揃えること。
  if (s.kind === 'ward') s.wardPct = wardPctOf(s);
  if (s.kind === 'vigor') s.hpBoost = hpBoostOf(s);
  if (s.kind === 'seal') { s.sealTime = sealTimeOf(s); s.coolTime = sealCoolOf(0); }
  if (s.kind === 'empower') s.atkBoost = atkBoostOf(s);
  if (s.kind === 'heal') s.manaCost = Math.max(s.manaCost, healManaFloor(s));
  if (s.dotTime > 0) s.dotDps = dotDpsOf(s);

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
  // 封印は強化で「止める時間が延び、再使用が縮む」
  if (s.kind === 'seal') { s.sealTime = sealTimeOf(s); s.coolTime = sealCoolOf(L); }
  if (s.kind === 'empower') s.atkBoost = atkBoostOf(s);
  if (s.kind === 'focus') s.mpRegenBonus = mpRegenBonusOf(s);
  // 強化で回復量が増えた分、消費MPの下限も上がる(MP1あたりの効率は一定に保つ)
  if (s.kind === 'heal') s.manaCost = Math.max(s.manaCost, healManaFloor(s));
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
export function mpRegenBonusOf(s: SpellStats): number {
  const base = Math.min(6, 1.5 + s.power / 16);
  return Math.round((s.targetAll ? base * 0.7 : base) * 10) / 10;
}

// 継続ダメージ(毎秒)。延焼系は腐蝕系より短いぶん強い。
export function dotDpsOf(s: SpellStats): number {
  return Math.max(1, Math.round(s.power * (s.dotStrong ? 0.28 : 0.18)));
}

// 行動不能にする秒数(威力から換算・上限6秒)
export function sealTimeOf(s: SpellStats): number {
  return Math.round(Math.min(13, 6 + s.power / 11.5) * 10) / 10;
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
  return Math.round((40 - 1.4 * L) * 10) / 10;
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
  if (s.kind === 'shield') return 6;
  if (s.kind === 'heal') return 5;
  if (s.kind === 'taunt') return 8;
  if (s.kind === 'ward') return 10;
  if (s.kind === 'vigor') return 14;
  if (s.kind === 'seal') return 16;
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
    v = (s.healPower * all / cycle) * 15;
  } else if (s.kind === 'ward') {
    // 被ダメを wardPct% 減らす。全属性(=どの敵にも効く)と単属性で価値が大きく違う。
    v = REF_DPS * (s.wardPct / 100) * 12 * upTime(s) * (s.targetAll ? 3.1 : 1.0);
  } else if (s.kind === 'vigor') {
    // 最大HP上昇 + 同量の即時回復。1秒あたりに供給するHPとして数える。
    v = (s.hpBoost * 2 * all / (s.castTime + spellCooldown(s))) * 27 * upTime(s);
  } else if (s.kind === 'seal') {
    // 敵全体の行動を止める = その割合ぶん敵のDPSを消している
    const stop = Math.min(0.85, s.sealTime / (s.castTime + spellCooldown(s)));
    v = REF_DPS * stop * 12 * 4.2;
  } else if (s.kind === 'empower') {
    // 与ダメ+atkBoost%。維持できるので、そのまま基準DPSへの上乗せとみなす。
    v = REF_DPS * (s.atkBoost / 100) * 12 * upTime(s) * all * 3.3;
  } else if (s.kind === 'focus') {
    // MP回復の上乗せ。MPが尽きて詠唱できない時間が減る = そのぶん手数が増える。
    v = REF_DPS * (s.mpRegenBonus / BASE_MP_REGEN) * 12 * upTime(s) * all * 1.0;
  } else {
    // 挑発: 敵の狙いを引き受ける。仲間が殴られない時間を作る役目。
    v = (s.hateGain / cycle) * 1.4 * 2.4 + 60;
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
  if (s.kind === 'focus') {
    const parts = [
      s.targetAll
        ? `【瞑想】全員のMP回復 毎秒+${s.mpRegenBonus.toFixed(1)}`
        : `【瞑想】MP回復 毎秒+${s.mpRegenBonus.toFixed(1)}(通常は毎秒${BASE_MP_REGEN})`,
      '20秒',
      `詠唱${s.castTime.toFixed(2)}秒`, `MP${s.manaCost}`, '再使用14秒',
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
