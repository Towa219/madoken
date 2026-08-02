// プレイヤーが選べるキャラクター。
//
// 見た目だけの選択で、性能には一切影響しない(どれを選んでも強さは同じ)。
// 並び順は public/img/manifest.json の players と対応している。

export interface CharacterDef {
  id: number;      // 0始まり。セーブにはこの番号を保存する
  name: string;
  note: string;    // 選択画面に出す一言
  scale: number;   // 表示倍率(下の説明を参照)
}

// scale について:
//   絵はどれも同じ高さに縮小されるが、帽子・杖・湯気・足元の魔法陣といった
//   装飾が縦を食う割合はキャラごとに違う。そのため、そのままだと
//   「人物そのものの大きさ」が揃わない。
//   装飾の多いキャラを少し大きく表示して、体格の見え方を合わせる。
//   数値を上げるとそのキャラだけ大きくなる(性能には一切影響しない)。
export const CHARACTERS: CharacterDef[] = [
  { id: 0, name: '黒金の魔女', note: '魔導書を手に、真理を読み解く', scale: 1.00 },
  { id: 1, name: '白銀の学士', note: '記録と観測を重んじる研究者', scale: 0.95 },
  { id: 2, name: '紅蓮の戦導士', note: '前へ出て杖を振るう実戦派', scale: 1.00 },
  { id: 3, name: '翠緑の薬導士', note: '調合と薬に通じた癒し手', scale: 1.12 },
  { id: 4, name: '紫紺の導師', note: '古き術を修めた大魔導士', scale: 1.14 },
];

// 表示倍率(範囲外なら等倍)
export function characterScale(raw: unknown): number {
  return CHARACTERS[clampCharId(raw)].scale;
}

export const CHARACTER_COUNT = CHARACTERS.length;

// 範囲外や欠損を安全な値に丸める(古いセーブ・改竄対策)
export function clampCharId(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n >= CHARACTER_COUNT) return 0;
  return n;
}

export function characterName(raw: unknown): string {
  return CHARACTERS[clampCharId(raw)].name;
}
