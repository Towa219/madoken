// ニックネームの登録簿(重複防止)
//
// 「名前 → 所有トークン」を保存し、別のトークンからは同じ名前を使えなくする。
// トークンは各ブラウザのセーブに入っている秘密の文字列で、
// キャラを初期化するとクライアントが解放を要求し、その名前は再び使えるようになる。
//
// Upstash未設定のときはメモリ上の登録簿になる(サーバー再起動で消える)。

import { nicknameKey, normalizeNickname, validateNickname } from '../shared/nickname';
import { persistent, redis } from './upstash';

const HKEY = 'madoken:names:v1'; // hash: 正規化した名前 → 所有トークン
const memory = new Map<string, string>();

export interface NameResult {
  ok: boolean;
  error?: string;
}

const TAKEN = 'そのニックネームは既に他の人が使っています。別の名前にしてください。';

// 名前を確保する。空いていれば登録し、自分のものなら成功、他人のものなら失敗。
export async function claimName(rawName: unknown, rawToken: unknown): Promise<NameResult> {
  const name = normalizeNickname(rawName);
  const err = validateNickname(name);
  if (err) return { ok: false, error: err };

  const token = String(rawToken ?? '').slice(0, 64);
  if (!token) return { ok: false, error: '登録用のIDがありません。ページを再読み込みしてください。' };

  const key = nicknameKey(name);

  if (!persistent) {
    const owner = memory.get(key);
    if (owner && owner !== token) return { ok: false, error: TAKEN };
    memory.set(key, token);
    return { ok: true };
  }

  try {
    const set = await redis(['HSETNX', HKEY, key, token]);
    if (Number(set) === 1) return { ok: true }; // 空いていたので確保できた
    const owner = await redis(['HGET', HKEY, key]);
    if (String(owner ?? '') === token) return { ok: true }; // 自分の名前
    return { ok: false, error: TAKEN };
  } catch (err2) {
    console.error('[ニックネーム] 登録簿の参照に失敗:', (err2 as Error).message);
    return { ok: true }; // 登録簿が落ちているときは遊べなくならないよう通す
  }
}

// 名前を手放す(キャラ初期化時)。所有者本人のときだけ消す。
export async function releaseName(rawName: unknown, rawToken: unknown): Promise<boolean> {
  const key = nicknameKey(normalizeNickname(rawName));
  const token = String(rawToken ?? '');
  if (!key || !token) return false;

  if (!persistent) {
    if (memory.get(key) !== token) return false;
    memory.delete(key);
    return true;
  }

  try {
    const owner = await redis(['HGET', HKEY, key]);
    if (String(owner ?? '') !== token) return false;
    await redis(['HDEL', HKEY, key]);
    return true;
  } catch (err) {
    console.error('[ニックネーム] 解放に失敗:', (err as Error).message);
    return false;
  }
}

// その名前が今すぐ使えるか(入力欄の事前チェック用)
export async function checkName(rawName: unknown, rawToken: unknown): Promise<NameResult> {
  const name = normalizeNickname(rawName);
  const err = validateNickname(name);
  if (err) return { ok: false, error: err };

  const key = nicknameKey(name);
  const token = String(rawToken ?? '');

  if (!persistent) {
    const owner = memory.get(key);
    return owner && owner !== token ? { ok: false, error: TAKEN } : { ok: true };
  }
  try {
    const owner = await redis(['HGET', HKEY, key]);
    const o = owner === null || owner === undefined ? '' : String(owner);
    return !o || o === token ? { ok: true } : { ok: false, error: TAKEN };
  } catch {
    return { ok: true };
  }
}
