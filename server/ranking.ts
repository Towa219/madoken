// オンラインランキング(共闘スコア)
// 注意: Render無料プランはディスクが永続しないため、
// サーバーの再起動・スリープ・デプロイでリセットされる(=サーバー稼働中の記録)。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface RankEntry {
  name: string;
  score: number;
  spells: string[]; // 装備魔法の表示名(最大4)
  date: string;
}

const FILE = 'data/ranking.json';
let entries: RankEntry[] = [];

try {
  entries = JSON.parse(readFileSync(FILE, 'utf8')) as RankEntry[];
} catch {
  entries = [];
}

export function submitScore(name: string, score: number, spells: string[]): void {
  const s = Math.round(score);
  if (s <= 0) return;
  entries.push({
    name: name.slice(0, 12),
    score: s,
    spells: spells.slice(0, 4).map(x => x.slice(0, 24)),
    date: new Date().toISOString().slice(0, 10),
  });
  entries.sort((a, b) => b.score - a.score);
  entries = entries.slice(0, 20);
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(FILE, JSON.stringify(entries), 'utf8');
  } catch {
    // 保存失敗(読み取り専用環境など)はメモリのみで続行
  }
}

export function topRanking(n: number): RankEntry[] {
  return entries.slice(0, n);
}
