// サーバー側セーブ(クラウドセーブ)
//
// ニックネーム登録簿と同じ「所有トークン」で本人確認する。
// 保存先は Upstash の HASH。未設定のときはメモリ上に持つ(再起動で消える)。
//
// 保存するのは魔法の性能を除いた軽い形。性能はレシピから再計算できるため、
// クライアント側の読み込み時に組み立て直す。

import { nicknameKey, normalizeNickname } from '../shared/nickname';
import { claimName } from './names';
import { persistent, redis } from './upstash';

const HKEY = 'madoken:save:v1';
const MAX_BYTES = 400_000; // 1人あたりの上限(約400KB)

const memory = new Map<string, string>();

export interface SaveResult {
  ok: boolean;
  error?: string;
  savedAt?: number;
}

export interface LoadResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  savedAt?: number;
}

interface Envelope {
  savedAt: number;
  data: unknown;
}

// 保存(本人のトークンでのみ書き込める)
export async function putSave(
  rawName: unknown, rawToken: unknown, data: unknown, savedAt: number,
): Promise<SaveResult> {
  const name = normalizeNickname(rawName);
  const owner = await claimName(name, rawToken); // 形式チェック+所有確認を兼ねる
  if (!owner.ok) return { ok: false, error: owner.error };

  const env: Envelope = { savedAt: Number(savedAt) || Date.now(), data };
  const body = JSON.stringify(env);
  if (body.length > MAX_BYTES) {
    return { ok: false, error: 'セーブデータが大きすぎます。' };
  }

  const key = nicknameKey(name);

  // 既存より古いデータでの上書きは拒否(別端末の新しい記録を守る)
  const cur = await readEnvelope(key);
  if (cur && cur.savedAt > env.savedAt + 60_000) {
    return {
      ok: false,
      error: 'サーバーにもっと新しいセーブがあります。先に「復元」してください。',
      savedAt: cur.savedAt,
    };
  }

  if (!persistent) {
    memory.set(key, body);
    return { ok: true, savedAt: env.savedAt };
  }
  try {
    await redis(['HSET', HKEY, key, body]);
    return { ok: true, savedAt: env.savedAt };
  } catch (err) {
    console.error('[クラウドセーブ] 保存に失敗:', (err as Error).message);
    return { ok: false, error: '保存に失敗しました。' };
  }
}

async function readEnvelope(key: string): Promise<Envelope | null> {
  const raw = persistent
    ? await redis(['HGET', HKEY, key]).catch(() => null)
    : memory.get(key) ?? null;
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw)) as Envelope;
  } catch {
    return null;
  }
}

// 読み込み(本人のトークンでのみ取り出せる)
export async function getSave(rawName: unknown, rawToken: unknown): Promise<LoadResult> {
  const name = normalizeNickname(rawName);
  const owner = await claimName(name, rawToken);
  if (!owner.ok) return { ok: false, error: owner.error };

  const env = await readEnvelope(nicknameKey(name));
  if (!env) return { ok: false, error: 'そのニックネームのセーブはまだありません。' };
  return { ok: true, data: env.data, savedAt: env.savedAt };
}

// 削除(キャラ初期化時)
export async function deleteSave(rawName: unknown, rawToken: unknown): Promise<boolean> {
  const name = normalizeNickname(rawName);
  const owner = await claimName(name, rawToken);
  if (!owner.ok) return false;
  const key = nicknameKey(name);
  if (!persistent) return memory.delete(key);
  try {
    await redis(['HDEL', HKEY, key]);
    return true;
  } catch {
    return false;
  }
}
