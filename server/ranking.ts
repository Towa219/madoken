// オンラインランキング(魔導値)
//
// スコア = 持っている魔法のうち、その人が装備できる数だけ魔導値の高い順に合計。
// 装備中のものではないので、装備を入れ替えても順位は変わらない。
// 「一番強い手札を作れたか」を競う。
// 装備数はボスを倒すと4→5→6と増えるので、合計する本数もそれに合わせる。
//
// 保存先は2通り:
//   1. Upstash Redis (環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN がある場合)
//      → サーバーを再起動・再デプロイしても記録が残る(恒久保存)
//   2. ローカルファイル + メモリ (環境変数が無い場合)
//      → Render無料プランではデプロイのたびに消える
//
// 記録はニックネームごとに「自己ベスト1件」だけを保持する。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { persistent, redis } from './upstash';
import { clampNickname } from '../shared/nickname';
import { equipLimit } from '../shared/data';
import { finalStats, spellMagicValue } from '../shared/spellcraft';
import type { ElementCounts, Rarity } from '../shared/types';

const RARITY_VALUES: Rarity[] = ['normal', 'rare', 'epic', 'legend'];
const MAX_SPELLS = 200; // 1回に受け取る魔法の上限(送りつけ対策)

export { persistent };

export interface RankEntry {
  name: string;
  score: number;
  spells: string[]; // 合計に使った魔法の表示名
  date: string;
}

// v1 は共闘スコア(クリアステージ×10+与ダメージ/20)だった。魔導値とは桁も意味も
// 違うので、キーを分けて作り直す。同じキーを使い回すと両方が混ざって並ぶ。
const ZKEY = 'madoken:ranking:v2';   // sorted set: member=ニックネーム, score=魔導値
const HKEY = 'madoken:rankmeta:v2';  // hash: ニックネーム → {spells,date}
const KEEP = 20;

// ---- ファイル/メモリ(フォールバック) ----

const FILE = 'data/ranking.json';
let local: RankEntry[] = [];

try {
  local = JSON.parse(readFileSync(FILE, 'utf8')) as RankEntry[];
} catch {
  local = [];
}

function saveLocal(): void {
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(FILE, JSON.stringify(local), 'utf8');
  } catch {
    // 読み取り専用環境などではメモリのみで続行
  }
}

function submitLocal(entry: RankEntry): void {
  const idx = local.findIndex(e => e.name === entry.name);
  if (idx >= 0) {
    if (local[idx].score >= entry.score) return; // 自己ベスト更新時のみ
    local[idx] = entry;
  } else {
    local.push(entry);
  }
  local.sort((a, b) => b.score - a.score);
  local = local.slice(0, KEEP);
  saveLocal();
}

// ---- 公開API ----

export function submitScore(name: string, score: number, spells: string[]): void {
  const s = Math.round(score);
  if (s <= 0) return;
  const entry: RankEntry = {
    name: clampNickname(name),
    score: s,
    spells: spells.slice(0, 4).map(x => x.slice(0, 24)),
    date: new Date().toISOString().slice(0, 10),
  };

  submitLocal(entry); // 恒久保存が使えない場合の受け皿として常に更新

  if (!persistent) return;
  // Upstashへは投げっぱなし(失敗してもゲームは止めない)
  void (async () => {
    try {
      const cur = await redis(['ZSCORE', ZKEY, entry.name]);
      if (cur !== null && cur !== undefined && Number(cur) >= entry.score) return;
      await redis(['ZADD', ZKEY, entry.score, entry.name]);
      await redis([
        'HSET', HKEY, entry.name,
        JSON.stringify({ spells: entry.spells, date: entry.date }),
      ]);
      await redis(['ZREMRANGEBYRANK', ZKEY, 0, -(KEEP + 1)]);
    } catch (err) {
      console.error('[ランキング] Upstashへの保存に失敗:', (err as Error).message);
    }
  })();
}

// 記録を消す(キャラ初期化でニックネームを手放したとき)。
// 消さないと、その名前を次に取った人のスコアとして残ってしまう。
export async function removeScore(name: string): Promise<void> {
  const key = clampNickname(name);
  const idx = local.findIndex(e => e.name === key);
  if (idx >= 0) {
    local.splice(idx, 1);
    saveLocal();
  }
  if (!persistent) return;
  try {
    await redis(['ZREM', ZKEY, key]);
    await redis(['HDEL', HKEY, key]);
  } catch (err) {
    console.error('[ランキング] 削除に失敗:', (err as Error).message);
  }
}

export async function topRanking(n: number): Promise<RankEntry[]> {
  if (!persistent) return local.slice(0, n);
  try {
    const raw = await redis(['ZREVRANGE', ZKEY, 0, n - 1, 'WITHSCORES']) as string[];
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const names: string[] = [];
    const scores: number[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      names.push(String(raw[i]));
      scores.push(Number(raw[i + 1]));
    }
    const metaRaw = await redis(['HMGET', HKEY, ...names]) as (string | null)[];
    return names.map((name, i) => {
      let spells: string[] = [];
      let date = '';
      try {
        const m = JSON.parse(metaRaw?.[i] ?? '{}') as { spells?: string[]; date?: string };
        spells = Array.isArray(m.spells) ? m.spells : [];
        date = String(m.date ?? '');
      } catch { /* メタ欠損は空で表示 */ }
      return { name, score: scores[i], spells, date };
    });
  } catch (err) {
    console.error('[ランキング] Upstashからの取得に失敗:', (err as Error).message);
    return local.slice(0, n);
  }
}

// 送られてきた魔法から「装備できる数だけ、魔導値の高い順に合計」した値を出す。
//
// 装備中のものではなく、持っている魔法すべてから選ぶ。装備の入れ替えで
// 順位が動かないようにするため。性能はレシピから計算し直すので、
// クライアントが魔導値を偽って送っても効かない。
// 合計する本数だけは撃破したボスの申告に依るが、これは魔法そのものと同じ扱い。
export function magicRankScore(
  raw: unknown, bossCleared: unknown, charId?: unknown,
): { total: number; names: string[] } {
  // 合計する本数はその人が装備できる数。ボスを倒していなければ4本のまま。
  const cleared = Array.isArray(bossCleared)
    ? (bossCleared as unknown[]).map(Number).filter(Number.isFinite)
    : [];
  const topN = equipLimit(cleared);
  const list = Array.isArray(raw) ? (raw as unknown[]).slice(0, MAX_SPELLS) : [];
  const scored = list.map(item => {
    const o = item as { name?: unknown; recipe?: unknown; level?: unknown; rarity?: unknown };
    const level = Math.max(0, Math.min(9, Math.floor(Number(o?.level) || 0)));
    const rarity = RARITY_VALUES.includes(o?.rarity as Rarity)
      ? (o.rarity as Rarity)
      : 'normal';
    // 選んでいるキャラの得意エレメントぶんも込みで計算する。
    // 実際に戦う時の強さと、順位に出る魔導値をずらさないため。
    const stats = finalStats((o?.recipe ?? {}) as ElementCounts, level, rarity, charId);
    return { name: String(o?.name ?? '魔弾').slice(0, 24), value: spellMagicValue(stats) };
  });
  scored.sort((a, b) => b.value - a.value);
  const top = scored.slice(0, topN);
  return {
    total: top.reduce((sum, x) => sum + x.value, 0),
    names: top.map(x => x.name),
  };
}
