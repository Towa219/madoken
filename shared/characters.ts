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
//   絵はどれも同じ高さに縮小されるので、頭身が違うと頭の大きさが揃わない。
//   以前は5体の頭身がばらばら(3〜5頭身)で、装飾が縦を食う割合も違ったため、
//   キャラごとに倍率で辻褄を合わせていた。
//   今は5体とも同じ指定(約3頭身)で描き直してあるので、倍率も揃えている。
//   1体だけ大きく/小さく見える時はここを動かす(性能には一切影響しない)。
//   顔の大きさは tools/artgen/head_size.py で測れる。出た倍率をそのまま
//   入れてはいけない(帽子・前髪・髭で顔が隠れる子は小さめに出る)。
//   気になると言われた子だけ、測定値の半分ほど寄せるのが安全。
export const CHARACTERS: CharacterDef[] = [
  { id: 0, name: '黒金の魔女', note: '魔導書を手に、真理を読み解く', scale: 1.00 },
  // 顔が大きい(測定 42.8%)。0.92 ではまだ大きいと言われたので測定値まで寄せた
  { id: 1, name: '白銀の学士', note: '記録と観測を重んじる研究者', scale: 0.85 },
  { id: 2, name: '紅蓮の戦導士', note: '前へ出て杖を振るう実戦派', scale: 1.00 },
  { id: 3, name: '翠緑の薬導士', note: '調合と薬に通じた癒し手', scale: 1.00 },
  // 髭のぶん顔が小さく見える(測定 33.0%)ので少し大きく表示する
  { id: 4, name: '紫紺の導師', note: '古き術を修めた大魔導士', scale: 1.08 },
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
