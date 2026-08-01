// オンラインランキング(共闘スコア)
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

export { persistent };

export interface RankEntry {
  name: string;
  score: number;
  spells: string[]; // 装備魔法の表示名(最大4)
  date: string;
}

const ZKEY = 'madoken:ranking:v1';   // sorted set: member=ニックネーム, score=スコア
const HKEY = 'madoken:rankmeta:v1';  // hash: ニックネーム → {spells,date}
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
    name: name.slice(0, 12),
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
