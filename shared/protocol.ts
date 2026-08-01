// クライアント⇔サーバー間のメッセージ型定義

import type { ElementCounts, ElementId } from './types';

// 参加時に送る魔法(レシピのみ。性能はサーバーが再計算する=改竄対策)
export interface SpellPayload {
  name: string;
  recipe: ElementCounts;
}

export interface CoopJoinOptions {
  name: string;
  spells: SpellPayload[];
  stage?: number; // 部屋作成時のみ
}

// サーバー→クライアント(演出イベント)
export interface ProjMsg {
  sid: string;      // 詠唱者
  x0: number;       // 発射位置
  targetX: number;
  attr: ElementId;
  power: number;
  delayMs: number;  // 着弾までの時間
}

export interface EProjMsg {
  i: number;        // 敵インデックス
  targetSid: string;
  delayMs: number;
}

export interface HitMsg {
  i: number;
  amount: number;
  crit: boolean;
  note: string;
  attr: ElementId;
  radius: number;
}

export interface PHitMsg { sid: string; amount: number; }
export interface HealMsg { sid: string; amount: number; }
export interface ResultMsg { win: boolean; drops: ElementId[]; rp: number; }
export interface ChatMsg { name: string; text: string; }
