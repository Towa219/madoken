// Upstash Redis (REST) の共通クライアント
// 環境変数が無い場合は persistent=false になり、呼び出し側はメモリ保存にフォールバックする。

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const persistent = Boolean(REST_URL && REST_TOKEN);

export async function redis(cmd: (string | number)[]): Promise<unknown> {
  if (!persistent) throw new Error('Upstash未設定');
  const res = await fetch(REST_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Upstash応答エラー ${res.status}`);
  const data = await res.json() as { result?: unknown; error?: string };
  if (data.error) throw new Error(`Upstashエラー: ${data.error}`);
  return data.result;
}
