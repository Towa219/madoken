// ペット(鳥)の定義と規則。試験中の機能。
//
// クライアントとサーバーの両方がこれを見る。
// 判定はサーバーが持つが、画面に出す数字も同じ式で出したいので、
// 計算は副作用の無い関数としてここに集める。
//
// ★ 時刻は必ず引数で受け取る(引数 now)。
//   モジュールの中で Date.now() を呼ぶと、サーバーの時計で数えたい所を
//   端末の時計で数えてしまう。孵化も寿命も、端末の時計を進めれば
//   いくらでもごまかせることになる。
//
// ★ ペットは「底上げ」に留める。満額でもプレイヤーの1割程度。
//   これ以上にすると「ペットが無いと戦えない」になり、試験を外せなくなる。
//
// ★ MPはHPと同じ数字にしてはいけない(2026-08-11に計算して気づいた)。
//   プレイヤーは HP260 / MP150 で持ち玉が違ううえ、MPは毎秒6ずつ戻る。
//   MP+26 は「4秒ぶんの回復を先渡し」に等しく、撃てる回数が目に見えて変わる。
//   HPの1割に合わせるなら、MPは2/3ほどに抑える必要がある。

// ---------------------------------------------------------------- 種類

export type PetSpeciesId =
  | 'sparrow' | 'lark' | 'swallow' | 'owl' | 'hawk' | 'dove' | 'crow';

export interface PetSpecies {
  id: PetSpeciesId;
  name: string;
  emoji: string;
  hp: number;          // 成鳥・遺伝子50のときの上昇量
  mp: number;
  note: string;
  // 育ちの速さ。カラスだけ遅い(両方に振れるぶんの釣り合い)。
  warmNeeded: number;  // 卵を何回温めれば孵るか(1日1回)
  chickDays: number;   // 雛でいる日数
  lifeDays: number;    // 成鳥でいる日数(遺伝子で前後する)
}

// ★ 合計値は 18〜26 の幅に収める。
//   26 が上限で、そこには タカ(HP特化) ハト(頑丈) カラス(両方) が並ぶ。
//   カラスは尖っていないぶん一番使いやすいので、育ちを遅くして釣り合わせた。
//   賢い鳥ほど大人になるのが遅い、という実際の性質にも合っている。
export const PET_SPECIES: Record<PetSpeciesId, PetSpecies> = {
  sparrow: {
    id: 'sparrow', name: 'スズメ', emoji: '🐦', hp: 12, mp: 5,
    note: '最初の1羽。素直で育てやすい',
    warmNeeded: 3, chickDays: 4, lifeDays: 20,
  },
  lark: {
    id: 'lark', name: 'ヒバリ', emoji: '🕊️', hp: 8, mp: 9,
    note: '均等寄りのMP型。朝に強い',
    warmNeeded: 3, chickDays: 4, lifeDays: 20,
  },
  swallow: {
    id: 'swallow', name: 'ツバメ', emoji: '🐧', hp: 6, mp: 12,
    note: 'MP型。速く飛ぶ',
    warmNeeded: 3, chickDays: 4, lifeDays: 18,
  },
  owl: {
    id: 'owl', name: 'フクロウ', emoji: '🦉', hp: 4, mp: 15,
    note: 'MP特化。長生きする',
    warmNeeded: 3, chickDays: 4, lifeDays: 26,
  },
  hawk: {
    id: 'hawk', name: 'タカ', emoji: '🦅', hp: 22, mp: 3,
    note: 'HP特化。気は荒く、寿命は短い',
    warmNeeded: 3, chickDays: 4, lifeDays: 15,
  },
  dove: {
    id: 'dove', name: 'ハト', emoji: '🕊', hp: 16, mp: 8,
    note: '頑丈で長生き',
    warmNeeded: 3, chickDays: 4, lifeDays: 24,
  },
  crow: {
    id: 'crow', name: 'カラス', emoji: '🐦‍⬛', hp: 13, mp: 10,
    note: '賢く、HPもMPも伸びる。ただし大人になるのが遅い',
    warmNeeded: 4, chickDays: 7, lifeDays: 20,
  },
};

export const PET_SPECIES_ORDER: PetSpeciesId[] = [
  'sparrow', 'lark', 'swallow', 'owl', 'hawk', 'dove', 'crow',
];

// ---------------------------------------------------------------- 個体値
//
// 同じ種類でも1羽ごとに差が出る。交配で親から子へ受け継がれる。
// 0〜100 の値を倍率に写す。50 が「ふつう」。

export const GENE_MIN = 0;
export const GENE_MAX = 100;

// HP/MP は 0.7〜1.3倍。寿命は振れ幅を狭めてある(短命すぎると育てる気が失せる)。
export const GENE_STAT_LOW = 0.7;
export const GENE_STAT_HIGH = 1.3;
export const GENE_LIFE_LOW = 0.8;
export const GENE_LIFE_HIGH = 1.2;

export function statMul(gene: number): number {
  const t = clampGene(gene) / GENE_MAX;
  return GENE_STAT_LOW + (GENE_STAT_HIGH - GENE_STAT_LOW) * t;
}

export function lifeMul(gene: number): number {
  const t = clampGene(gene) / GENE_MAX;
  return GENE_LIFE_LOW + (GENE_LIFE_HIGH - GENE_LIFE_LOW) * t;
}

export function clampGene(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  return Math.max(GENE_MIN, Math.min(GENE_MAX, n));
}

// ---------------------------------------------------------------- 時間

export const DAY_MS = 24 * 60 * 60 * 1000;

// 卵を温められる間隔。1日1回のつもりだが、きっかり24時間にすると
// 「昨日と同じ時刻より1分早い」だけで断られ、生活の時間がずれていく。
// 20時間にして、毎日だいたい同じ頃に触れば進むようにする。
export const WARM_INTERVAL_MS = 20 * 60 * 60 * 1000;

// 老いてから死ぬまで。効果が落ちるので「そろそろだ」と分かる。
export const ELDER_DAYS = 5;

export type PetStage = 'egg' | 'chick' | 'adult' | 'elder' | 'dead';

// 段階ごとの効果の割合。雛は半分、老いは7割。
export const STAGE_POWER: Record<PetStage, number> = {
  egg: 0, chick: 0.5, adult: 1.0, elder: 0.7, dead: 0,
};

export const STAGE_NAME: Record<PetStage, string> = {
  egg: '卵', chick: '雛', adult: '成鳥', elder: '老鳥', dead: '天へ',
};

// ---------------------------------------------------------------- 1羽ぶん

export interface Pet {
  id: string;
  ownerName: string;        // ニックネーム
  species: PetSpeciesId;
  name: string;             // 付けた名前(空なら種類名)
  sex: 'm' | 'f';
  hpGene: number;
  mpGene: number;
  lifeGene: number;
  // 卵のあいだ
  warmCount: number;        // 温めた回数
  lastWarmAt: number;       // 最後に温めた時刻(ms)
  // 孵ってから
  hatchedAt: number;        // 0 ならまだ卵
  // 交配所へ預けているか。預けている間は戦闘に連れて行けない。
  boarded: boolean;
  // 親(図鑑と遺伝の記録用。居なければ空)
  parents: [string, string] | null;
  bornAt: number;           // 卵として生まれた時刻
}

// 名前が空なら種類名を出す。図鑑でも戦闘でも同じ呼び方にするため、
// 表示に使う名前はここに集約する。
export function petDisplayName(pet: Pet): string {
  return pet.name.trim() || PET_SPECIES[pet.species].name;
}

// この個体が成鳥でいられる日数(遺伝子ぶんを掛けたもの)
export function adultDaysOf(pet: Pet): number {
  return PET_SPECIES[pet.species].lifeDays * lifeMul(pet.lifeGene);
}

// 孵ってから死ぬまでの長さ(ms)
export function lifetimeMsOf(pet: Pet): number {
  const sp = PET_SPECIES[pet.species];
  return (sp.chickDays + adultDaysOf(pet) + ELDER_DAYS) * DAY_MS;
}

// 今どの段階か。
//
// ★ now は必ず呼ぶ側から渡す。サーバーで数えるため。
export function stageOf(pet: Pet, now: number): PetStage {
  if (pet.hatchedAt <= 0) return 'egg';
  const sp = PET_SPECIES[pet.species];
  const age = now - pet.hatchedAt;
  const chick = sp.chickDays * DAY_MS;
  const adult = chick + adultDaysOf(pet) * DAY_MS;
  const end = adult + ELDER_DAYS * DAY_MS;
  if (age < chick) return 'chick';
  if (age < adult) return 'adult';
  if (age < end) return 'elder';
  return 'dead';
}

export interface PetBonus { hp: number; mp: number; }

// この個体が今どれだけ底上げするか。卵と死んだ個体は 0。
export function bonusOf(pet: Pet, now: number): PetBonus {
  const power = STAGE_POWER[stageOf(pet, now)];
  if (power <= 0) return { hp: 0, mp: 0 };
  const sp = PET_SPECIES[pet.species];
  return {
    hp: Math.round(sp.hp * statMul(pet.hpGene) * power),
    mp: Math.round(sp.mp * statMul(pet.mpGene) * power),
  };
}

// 卵をあと何回温めれば孵るか
export function warmLeft(pet: Pet): number {
  return Math.max(0, PET_SPECIES[pet.species].warmNeeded - pet.warmCount);
}

// 今すぐ温められるか(前回から WARM_INTERVAL_MS 経っているか)
export function canWarm(pet: Pet, now: number): boolean {
  return pet.hatchedAt <= 0 && now - pet.lastWarmAt >= WARM_INTERVAL_MS;
}

// ---------------------------------------------------------------- 所持

// 手元に置ける数(卵・雛・成鳥をぜんぶ含む)。
// 交配所へ預けている間は数に入れない ― 預ける動機を作るため。
export const MAX_PETS = 6;

export function countHeld(pets: Pet[]): number {
  return pets.filter(p => !p.boarded).length;
}

// ---------------------------------------------------------------- 交配

// 子の遺伝子は「両親の平均 ± ゆらぎ」。
// 平均だけだと代を重ねるほど真ん中に寄って個性が消えるので、
// 揺らしてから丸める。稀に親を超える子が出るのはこのため。
export const BREED_JITTER = 18;

// 卵ができるまで(交配してから)。孵化とは別の待ち時間。
export const BREED_EGG_HOURS = 12;

// 種類が両親のどちらとも違うものになる確率。
// 「たまに知らない鳥が生まれる」ための逃げ道。これが無いと、
// 手持ちの種類からしか増えず、7種を集めきれない人が出る。
export const BREED_MUTATE_RATE = 0.08;

function jitter(v: number, rnd: () => number): number {
  return clampGene(v + Math.round((rnd() * 2 - 1) * BREED_JITTER));
}

export interface BreedResult {
  species: PetSpeciesId;
  sex: 'm' | 'f';
  hpGene: number;
  mpGene: number;
  lifeGene: number;
}

// 交配の結果を決める。判定はサーバーで行い、rnd はサーバーが渡す。
export function breed(a: Pet, b: Pet, rnd: () => number = Math.random): BreedResult {
  const mutate = rnd() < BREED_MUTATE_RATE;
  let species: PetSpeciesId;
  if (mutate) {
    species = PET_SPECIES_ORDER[Math.floor(rnd() * PET_SPECIES_ORDER.length)];
  } else {
    species = rnd() < 0.5 ? a.species : b.species;
  }
  return {
    species,
    sex: rnd() < 0.5 ? 'm' : 'f',
    hpGene: jitter((a.hpGene + b.hpGene) / 2, rnd),
    mpGene: jitter((a.mpGene + b.mpGene) / 2, rnd),
    lifeGene: jitter((a.lifeGene + b.lifeGene) / 2, rnd),
  };
}

// 交配できる組み合わせか。
// 死んだ個体・卵・雛は親になれない(成鳥と老鳥だけ)。
export function canBreed(a: Pet, b: Pet, now: number): string | null {
  if (a.id === b.id) return '同じ個体どうしは交配できない。';
  if (a.sex === b.sex) return '♂と♀の組み合わせが要る。';
  for (const p of [a, b]) {
    const st = stageOf(p, now);
    if (st !== 'adult' && st !== 'elder') {
      return `${petDisplayName(p)}はまだ交配できない(成鳥から)。`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 新しい卵

// 卵から始める時の遺伝子。野生の卵は真ん中あたりに散らす。
// 交配で生まれた子のほうが尖るようにして、育てる意味を作る。
export const WILD_GENE_LOW = 30;
export const WILD_GENE_HIGH = 70;

export function wildGene(rnd: () => number = Math.random): number {
  return Math.round(WILD_GENE_LOW + rnd() * (WILD_GENE_HIGH - WILD_GENE_LOW));
}

// ボスを倒した時に出る卵の種類。
// 深いボスほど珍しい鳥が出る ― 進んだ人へのご褒美にする。
export function eggSpeciesForBoss(
  stage: number, rnd: () => number = Math.random,
): PetSpeciesId {
  const early: PetSpeciesId[] = ['sparrow', 'lark', 'dove'];
  const mid: PetSpeciesId[] = ['swallow', 'dove', 'lark', 'hawk'];
  const deep: PetSpeciesId[] = ['owl', 'hawk', 'crow', 'swallow'];
  const pool = stage >= 35 ? deep : stage >= 20 ? mid : early;
  return pool[Math.floor(rnd() * pool.length)];
}

// ---------------------------------------------------------------- 卵を伏せる
//
// 卵のうちは「何の鳥が生まれるか」を分からなくする。孵る瞬間を見せ場にしたい。
//
// ★ 画面で隠すだけでは足りない。ペットの中身はそのまま JSON で端末へ届くので、
//   開発者ツールを開けば species が読めてしまう。伏せるならサーバーが
//   送らないところまでやる必要がある(だから maskPet はサーバーが呼ぶ)。
//
// ★ 代わりに手がかりを出す。まったくの無情報だと温める気にならない。
//   ただし手がかりだけで種類が決まってしまっては伏せた意味が無いので、
//   下の表はわざと2種ずつ同じ見た目にしてある(見て分かるのは「どちらか」まで)。
//   カラスだけは温める回数が4回で他と違うため、そこで割れてしまうが、
//   カラスは交配でしか狙って出せない当たりなので、分かってよい。

export interface EggHint {
  size: string;        // 大きさ
  shell: string;       // 殻の色(名前)
  shellCss: string;    // 殻の色(絵に使う)
  pattern: string;     // 模様
  warmNeeded: number;  // あと何回温めるかを出すのに要る
}

const EGG_LOOK: Record<PetSpeciesId, Omit<EggHint, 'warmNeeded'>> = {
  // 小さい・白・無地 … ツバメ / フクロウ
  swallow: { size: '小さい', shell: '白', shellCss: '#f4f2ec', pattern: '無地' },
  owl: { size: '小さい', shell: '白', shellCss: '#f4f2ec', pattern: '無地' },
  // ふつう・クリーム・斑点 … スズメ / ヒバリ
  sparrow: { size: 'ふつう', shell: 'クリーム', shellCss: '#efe0c0', pattern: '斑点' },
  lark: { size: 'ふつう', shell: 'クリーム', shellCss: '#efe0c0', pattern: '斑点' },
  // 大きい・褐色・まだら … タカ / ハト
  hawk: { size: '大きい', shell: '褐色', shellCss: '#c9a37a', pattern: 'まだら' },
  dove: { size: '大きい', shell: '褐色', shellCss: '#c9a37a', pattern: 'まだら' },
  // ふつう・褐色・まだら … カラス(温めが4回なので、どのみち割れる)
  crow: { size: 'ふつう', shell: '褐色', shellCss: '#c9a37a', pattern: 'まだら' },
};

export function eggHintOf(species: PetSpeciesId): EggHint {
  return { ...EGG_LOOK[species], warmNeeded: PET_SPECIES[species].warmNeeded };
}

// 端末へ送る形。卵のうちは species が null になる。
export type WirePet = Omit<Pet, 'species'> & {
  species: PetSpeciesId | null;
  hint?: EggHint;
};

// サーバーが端末へ返す直前に通す。孵っていれば素通し。
export function maskPet(pet: Pet): WirePet {
  if (pet.hatchedAt > 0) return pet;
  const { species, ...rest } = pet;
  return { ...rest, species: null, hint: eggHintOf(species) };
}

// 卵の呼び名。名前を付けていれば名前、無ければ「たまご」。
// 種類名を出すわけにはいかないので petDisplayName とは別に用意する。
export function wireDisplayName(pet: WirePet): string {
  if (pet.name.trim()) return pet.name.trim();
  return pet.species ? PET_SPECIES[pet.species].name : 'たまご';
}
