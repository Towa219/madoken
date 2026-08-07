// 使用を禁じたニックネームの一覧(管理用)
//
// ランキングに不適切な名前が載った時、記録を消すだけでは同じ名前で
// また登録されてしまう。名前そのものを塞げるようにしておく。
//
// 判定は「正規化した名前」で行う(全角/半角・大文字小文字の違いで
// すり抜けられないようにするため。nicknameKey が揃えてくれる)。
//
// Upstash が設定されていなければメモリだけに持つ。
// サーバーを再起動すると消えるが、恒久保存は本番(Render + Upstash)で
// 効いていればよい。

import { nicknameKey, normalizeNickname } from '../shared/nickname';
import { persistent, redis } from './upstash';

const SKEY = 'madoken:banned:v1'; // set: 正規化した名前
const memory = new Set<string>();
let loaded = false;

// 起動後の最初の判定でまとめて読む。
// 1件ずつ問い合わせると、名前を決める画面の応答がそのぶん遅くなる。
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!persistent) return;
  try {
    const raw = await redis(['SMEMBERS', SKEY]) as string[];
    if (Array.isArray(raw)) for (const k of raw) memory.add(String(k));
  } catch (err) {
    console.error('[禁止名] 読み込みに失敗:', (err as Error).message);
  }
}

export async function isBanned(rawName: unknown): Promise<boolean> {
  await load();
  return memory.has(nicknameKey(normalizeNickname(rawName)));
}

export async function banName(rawName: unknown): Promise<string> {
  await load();
  const name = normalizeNickname(rawName);
  const key = nicknameKey(name);
  if (!key) return '';
  memory.add(key);
  if (persistent) {
    try {
      await redis(['SADD', SKEY, key]);
    } catch (err) {
      console.error('[禁止名] 保存に失敗:', (err as Error).message);
    }
  }
  return name;
}

export async function unbanName(rawName: unknown): Promise<string> {
  await load();
  const name = normalizeNickname(rawName);
  const key = nicknameKey(name);
  if (!key) return '';
  memory.delete(key);
  if (persistent) {
    try {
      await redis(['SREM', SKEY, key]);
    } catch (err) {
      console.error('[禁止名] 削除に失敗:', (err as Error).message);
    }
  }
  return name;
}

export async function bannedNames(): Promise<string[]> {
  await load();
  return [...memory].sort();
}
