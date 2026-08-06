// プレイヤーが選べるキャラクター。
//
// それぞれ得意なエレメントを1つ持ち、そのエレメントを使った魔法だけ威力が上がる。
// 並び順は public/img/manifest.json の players と対応している。

import type { ElementId } from './types';

export interface CharacterDef {
  id: number;         // 0始まり。セーブにはこの番号を保存する
  name: string;
  note: string;       // 選択画面に出す一言
  element: ElementId; // 得意なエレメント
  scale: number;      // 表示倍率(下の説明を参照)
}

// 得意エレメントを1個でも含む魔法の威力にかかる倍率。
//
// 「1個でも含めば効く」にしてあるのは、得意属性だけで固めた構成しか
// 選べなくなるのを避けるため。多く使うほど強くする形にすると、
// 相性や系統より属性合わせが優先されてしまい、調合の幅が狭くなる。
export const CHAR_POWER_BONUS = 0.10;

// キャラを変えるのにかかる研究P。
// 無料だと魔法ごとに着せ替えるだけの操作になり、選ぶ意味が無くなる。
// 最初の1体を決めるときは無料。
export const CHAR_CHANGE_COST = 200;

// scale について:
//   絵はどれも同じ高さに縮小されるので、頭身が違うと頭の大きさが揃わない。
//   ここで1体ごとに拡大・縮小して、頭の大きさを揃える(性能には影響しない)。
//
//   大きさは tools/artgen/head_size.py で測る。見るのは「両目の外端から
//   外端までの幅」。顔の大きさは目で測るのがいちばん当てになる ―
//   肌の幅は前髪・帽子・髭で隠れ、髪込みの頭の幅は髪型の量で変わるが、
//   目の大きさと間隔は絵柄が同じなら顔の大きさにそのまま比例する。
//   ※ 減色(--shrink)の前に測ること。減色すると肌の色が動いて数値がずれる。
//
//   測定値を揃える倍率をそのまま入れてはいけない。倍率は全身にかかるので、
//   寄せすぎると背丈が不自然に変わる(実際に「背が高すぎる」と指摘を受けた)。
//   ±8%までに抑え、頭を揃えきるより背丈の自然さを優先する。
//   帽子や髭のある子は測定値そのものが当てにならない(紫紺は測ると1.37倍
//   必要と出るが、そのとおりにすると1人だけ見上げるほど大きくなる)。
// 測定値(両目の幅 / 全身の高さ): 35.5% / 43.2% / 26.5% / 39.8% / 27.5% / 43.5%(平均 36.0%)
export const CHARACTERS: CharacterDef[] = [
  { id: 0, name: '黒金の魔女', note: '雷を操り、魔導書に真理を読む',
    element: 'thunder', scale: 1.00 },
  { id: 1, name: '白銀の学士', note: '風を読み、記録と観測を重んじる',
    element: 'wind', scale: 0.90 },
  { id: 2, name: '紅蓮の戦導士', note: '炎を纏い、前へ出て杖を振るう',
    element: 'fire', scale: 1.10 },
  { id: 3, name: '翠緑の薬導士', note: '水を扱い、調合と薬に通じた癒し手',
    element: 'water', scale: 0.94 },
  { id: 4, name: '紫紺の導師', note: '大地を鎮める、古き術の大魔導士',
    element: 'earth', scale: 1.10 },
  { id: 5, name: '蒼氷の術士', note: '氷を結び、静けさの中で術を編む',
    element: 'ice', scale: 0.90 },
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

export function characterElement(raw: unknown): ElementId {
  return CHARACTERS[clampCharId(raw)].element;
}
