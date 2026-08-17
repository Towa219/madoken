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

// 「これより後戻りしたら異常」と言える項目。
//
// ★ researchP や spells の数を見てはいけない。研究Pは使えば減るし、
//   魔法は分解すれば減る。正常な遊びで下がるものを後退と見なすと、
//   まともな保存まで拒んでしまう。
//   ここに並べるのは「増える一方のもの」だけ。
function 進み具合(d: unknown): Record<string, number> {
  const o = (d ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const 数 = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    到達ステージ: n(o.maxStage),
    最高ステージ: n(o.bestStage),
    発見した系統: 数(o.discovered),
    倒したボス: 数(o.bossCleared),
  };
}

// 後退している項目を並べて返す(空なら後退していない)。
function 後退した項目(古い: unknown, 新しい: unknown): string[] {
  const a = 進み具合(古い);
  const b = 進み具合(新しい);
  return Object.keys(a).filter(k => b[k] < a[k]).map(k => `${k} ${a[k]}→${b[k]}`);
}

// 保存(本人のトークンでのみ書き込める)
//
// ★ savedAt は端末から受け取らない。サーバーの時計で打つ。
//   以前は端末の Date.now() をそのまま信じて新旧を比べていた。端末の時計が
//   ずれていたり、古い状態を抱えたタブが後から保存したりすると、
//   「中身は古いのに時刻だけ新しい」記録がサーバーに残る。すると本物の端末が
//   「別の端末に新しい記録があります」と言われ続け、取り込むと進行が消える。
//   2026-08-17、実際に研究Pが1/4に戻りチケットが0→5に増える事故が起きた。
//
// ★ 新旧の判定も時刻の大小をやめ、baseSavedAt(この端末が最後に見た版)が
//   今の版と一致するかで見る。時計に依存しない。
export async function putSave(
  rawName: unknown, rawToken: unknown, data: unknown, baseSavedAt: number | null,
  force = false,
): Promise<SaveResult> {
  const name = normalizeNickname(rawName);
  const owner = await claimName(name, rawToken); // 形式チェック+所有確認を兼ねる
  if (!owner.ok) return { ok: false, error: owner.error };

  const env: Envelope = { savedAt: Date.now(), data };
  const body = JSON.stringify(env);
  if (body.length > MAX_BYTES) {
    return { ok: false, error: 'セーブデータが大きすぎます。' };
  }

  const key = nicknameKey(name);
  const cur = await readEnvelope(key);

  // ① 版の食い違い。別の端末(や古いタブ)が後から書いていたら止める。
  //    force は「別の記録があると知らせたうえで、それでもこの端末を残すと
  //    本人が選んだ」場合だけ立つ。知らずに消えることはない。
  //    baseSavedAt を送ってこない古い端末は、この確認を飛ばす(②で守る)。
  if (!force && cur && baseSavedAt !== null && cur.savedAt !== baseSavedAt) {
    return {
      ok: false,
      error: 'サーバーの記録が別の場所で更新されています。先に「取り込む」を確かめてください。',
      savedAt: cur.savedAt,
    };
  }

  // ② 後退の歯止め。①をすり抜けても、進み具合が減る保存は拒む。
  //    増える一方のものだけを見るので、正常な遊びで引っかかることはない。
  if (!force && cur) {
    const 後退 = 後退した項目(cur.data, env.data);
    if (後退.length > 0) {
      console.warn(`[クラウドセーブ] 後退する保存を拒否 ${name}: ${後退.join(' / ')}`);
      return {
        ok: false,
        error: `進み具合が戻る保存だったので中止しました(${後退.join('・')})。`
          + '古い画面が残っていないか確かめてください。',
        savedAt: cur.savedAt,
      };
    }
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
// 名前から到達状況だけを取り出す(Discordの在室レポート用)。
//
// 本人確認(トークン)は求めない。返すのはクリア済みステージなど
// ランキングにも出ている程度の情報だけで、セーブ本体は渡さない。
export async function progressOf(rawName: unknown): Promise<{
  bestStage: number; maxStage: number; spells: number; discovered: number;
} | null> {
  const name = normalizeNickname(rawName);
  if (!name) return null;
  const env = await readEnvelope(nicknameKey(name));
  const d = env?.data as Record<string, unknown> | undefined;
  if (!d) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    bestStage: n(d.bestStage),
    maxStage: n(d.maxStage),
    spells: Array.isArray(d.spells) ? d.spells.length : 0,
    discovered: Array.isArray(d.discovered) ? d.discovered.length : 0,
  };
}

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
