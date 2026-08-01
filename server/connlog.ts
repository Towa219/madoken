// 接続ログ: 誰がいつどこから接続したかを記録する(運営・不正対策用)
//
// 記録内容: 時刻 / ニックネーム / 接続元IP / 推定地域・回線 / 接続先(ロビー・共闘・決闘)
// 出力先は2つ:
//   1. 標準出力(Renderのログ画面でそのまま読める)
//   2. Upstash(設定済みなら最新200件を保存し、管理APIから読める)
//
// ※IPは個人情報になり得るため、公開せず、目的を運営に限って扱うこと。

import type { IncomingMessage } from 'node:http';
import { persistent, redis } from './upstash';

const LIST_KEY = 'madoken:connlog:v1';
const KEEP = 200;

export interface ConnEntry {
  at: string;      // ISO日時
  where: string;   // lobby / coop / duel
  name: string;    // ニックネーム
  ip: string;
  region: string;  // 推定地域(国・都道府県・市)
  isp: string;     // 回線事業者
}

const recent: ConnEntry[] = [];
const geoCache = new Map<string, { region: string; isp: string }>();

// リバースプロキシ(Render)経由でも元のIPを取り出す
export function clientIp(req?: IncomingMessage): string {
  if (!req) return '';
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw) return String(raw).split(',')[0].trim();
  return req.socket?.remoteAddress ?? '';
}

function isPrivate(ip: string): boolean {
  return !ip
    || ip === '::1' || ip.startsWith('127.')
    || ip.startsWith('10.') || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip.startsWith('::ffff:127.');
}

// IPからおおよその地域を推定(ip-api.com・無料・キー不要・日本語対応)
async function lookupGeo(ip: string): Promise<{ region: string; isp: string }> {
  if (isPrivate(ip)) return { region: 'ローカル', isp: '-' };
  const hit = geoCache.get(ip);
  if (hit) return hit;
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}`
      + '?fields=status,country,regionName,city,isp&lang=ja';
    const res = await fetch(url);
    const d = await res.json() as {
      status?: string; country?: string; regionName?: string; city?: string; isp?: string;
    };
    const out = d.status === 'success'
      ? {
          region: [d.country, d.regionName, d.city].filter(Boolean).join(' / ') || '不明',
          isp: d.isp ?? '不明',
        }
      : { region: '不明', isp: '不明' };
    geoCache.set(ip, out);
    return out;
  } catch {
    return { region: '取得失敗', isp: '-' };
  }
}

// 接続を記録する(投げっぱなし。失敗してもゲームは止めない)
export function logConnection(where: string, name: string, ip: string): void {
  void (async () => {
    const geo = await lookupGeo(ip);
    const entry: ConnEntry = {
      at: new Date().toISOString(),
      where,
      name: name.slice(0, 12),
      ip,
      region: geo.region,
      isp: geo.isp,
    };
    recent.unshift(entry);
    if (recent.length > KEEP) recent.length = KEEP;
    console.log(
      `[接続] ${entry.at} ${entry.where} "${entry.name}" ${entry.ip} (${entry.region} / ${entry.isp})`,
    );
    if (!persistent) return;
    try {
      await redis(['LPUSH', LIST_KEY, JSON.stringify(entry)]);
      await redis(['LTRIM', LIST_KEY, 0, KEEP - 1]);
    } catch (err) {
      console.error('[接続ログ] 保存に失敗:', (err as Error).message);
    }
  })();
}

// そのニックネームが最初に接続してきたときの記録(IP・地域・回線)を返す。
// Discordの在室レポートで「誰がどこから繋いでいるか」を出すのに使う。
export function connInfoOf(name: string): ConnEntry | undefined {
  const key = name.trim();
  if (!key) return undefined;
  // recent は新しい順なので、末尾から探すと「最初の接続」になる
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].name === key) return recent[i];
  }
  return undefined;
}

export async function recentConnections(n: number): Promise<ConnEntry[]> {
  if (!persistent) return recent.slice(0, n);
  try {
    const raw = await redis(['LRANGE', LIST_KEY, 0, n - 1]) as string[];
    if (!Array.isArray(raw)) return recent.slice(0, n);
    return raw.map(s => JSON.parse(s) as ConnEntry);
  } catch {
    return recent.slice(0, n);
  }
}
