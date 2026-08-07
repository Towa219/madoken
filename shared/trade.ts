// エレメントの取引(プレイヤー間の個人取引) ― 相場の決まりと受け渡しの型
//
// 値切りも吹っかけもできない固定相場。1エレメントの「価値」を決めておき、
// 二人が卓に出したものの価値が釣り合った時だけ取引が成立する。
//
//   火・水・風・土・雷・氷 …… 価値 1
//   光・闇 ………………………… 価値 4
//
// この1本の物差しで、決めたい3つの相場がすべて表せる。
//   基本6種どうし    1 : 1   (1 = 1)
//   基本6種 ↔ 光・闇  4 : 1   (4 = 4)
//   光 ↔ 闇          1 : 1   (4 = 4)
//
// 組み合わせごとの表を持つと、種類を足した時に片方だけ直して食い違う。
// 価値だけを持ち、比は毎回そこから割り出す。
//
// 判定はこのファイルだけに置き、画面とサーバーの両方が同じ関数を通す。
// 画面側だけで見ていると、通信を書き換えられた時に釣り合わない取引が通る。

import { ELEMENT_ORDER } from './data';
import type { ElementCounts, ElementId } from './types';

// 1個あたりの価値。光・闇は基本6種の4個ぶん。
export const ELEMENT_VALUE: Record<ElementId, number> = {
  fire: 1, water: 1, wind: 1, earth: 1, thunder: 1, ice: 1,
  light: 4, dark: 4,
};

// 希少なエレメント(価値が基本の4倍)かどうか
export function isRareElement(id: ElementId): boolean {
  return ELEMENT_VALUE[id] > 1;
}

export const TRADE_MAX_PER_KIND = 99;   // 1種類あたり卓に出せる上限
export const TRADE_INVITE_MS = 60_000;  // 誘いの有効時間(1分)

// 取引の卓。二人ぶんの出し物と「準備完了」を持つ。
export interface TradeSeatView {
  offer: ElementCounts;
  ready: boolean;
}

// 双方に配る卓の様子
export interface TradeView {
  mine: ElementCounts;
  theirs: ElementCounts;
  myReady: boolean;
  theirReady: boolean;
}

// 外から来た個数表を安全な形に整える。
// 知らない種類・小数・負の数・上限超えはすべてここで落とす。
export function sanitizeCounts(raw: unknown): ElementCounts {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: ElementCounts = {};
  for (const id of ELEMENT_ORDER) {
    const n = Math.floor(Number(o[id] ?? 0));
    if (!Number.isFinite(n) || n <= 0) continue;
    out[id] = Math.min(n, TRADE_MAX_PER_KIND);
  }
  return out;
}

// 出し物の合計価値
export function countsValue(counts: ElementCounts): number {
  let v = 0;
  for (const id of ELEMENT_ORDER) v += (counts[id] ?? 0) * ELEMENT_VALUE[id];
  return v;
}

export function countsTotal(counts: ElementCounts): number {
  let n = 0;
  for (const id of ELEMENT_ORDER) n += counts[id] ?? 0;
  return n;
}

export function isEmptyCounts(counts: ElementCounts): boolean {
  return countsTotal(counts) === 0;
}

// 取引が成立できる状態か。駄目な理由を文で返す(問題なければ null)。
//
// 「片方が空」を弾いているのは、贈り物の形にしないため。
// 相場を固定した意味が無くなり、名前を借りた受け渡しに使われる。
export function checkTrade(a: ElementCounts, b: ElementCounts): string | null {
  if (isEmptyCounts(a) || isEmptyCounts(b)) {
    return 'どちらも1つ以上出す必要がある。';
  }
  const va = countsValue(a);
  const vb = countsValue(b);
  if (va !== vb) {
    return `釣り合っていない(${va} 対 ${vb})。光と闇は基本6種4個ぶん。`;
  }
  return null;
}

// 手持ちで出せる量かどうか
export function canAfford(
  inventory: Record<ElementId, number>, offer: ElementCounts,
): boolean {
  for (const id of ELEMENT_ORDER) {
    if ((offer[id] ?? 0) > (inventory[id] ?? 0)) return false;
  }
  return true;
}
