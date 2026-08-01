// Discordへの定期通知
//
// レポートにはニックネームに加えてIP・推定地域・回線事業者を載せる。
// ※IPは個人情報になり得るので、送信先は運営者だけが見られる非公開チャンネルにすること。
//
// 環境変数:
//   DISCORD_WEBHOOK_URL   … 送信先のWebhook URL(未設定なら通知しない)
//   DISCORD_INTERVAL_MIN  … 送信間隔(分)。既定30
//   DISCORD_SEND_EMPTY    … "1" なら誰もいなくても送る(既定は送らない)

import { connInfoOf } from './connlog';
import { presenceSnapshot, uniqueNames } from './presence';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const INTERVAL_MIN = Math.max(1, Number(process.env.DISCORD_INTERVAL_MIN) || 30);
const SEND_EMPTY = process.env.DISCORD_SEND_EMPTY === '1';

export const discordEnabled = Boolean(WEBHOOK);

// Discordは素っ気ないUser-Agentを弾くことがあるので明示する
async function post(content: string): Promise<void> {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'madoken-server/1.0 (+https://madoken.onrender.com)',
      },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!res.ok) {
      console.error(`[Discord] 送信失敗 ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error('[Discord] 送信エラー:', (err as Error).message);
  }
}

// レポート本文を組み立てる(動作確認用にexport)
export function buildReport(onlineCount: number): string {
  const rooms = presenceSnapshot();
  const names = uniqueNames();
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const lines: string[] = [
    `**【まどけん】在室レポート** (${now})`,
    `プレイ中(ページを開いている人): **${onlineCount}人**`,
    `オンライン接続中: **${names.length}人**`,
  ];

  // 誰がどこから繋いでいるか(最初の接続時に記録したIP・地域・回線)
  for (const name of names) {
    const info = connInfoOf(name);
    if (!info) {
      lines.push(`・**${name}** — 接続情報なし(サーバー再起動前の接続)`);
      continue;
    }
    const at = new Date(info.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    lines.push(
      `・**${name}** — \`${info.ip}\` (${info.region} / ${info.isp}) 初回接続 ${at}`,
    );
  }

  if (rooms.length === 0) {
    lines.push('部屋: なし');
  } else {
    lines.push('部屋:');
    for (const r of rooms) {
      lines.push(`・${r.type}${r.label ? `(${r.label})` : ''}: ${r.names.join('、')}`);
    }
  }
  lines.push('<https://madoken.onrender.com>');
  return lines.join('\n');
}

// 定期送信を開始する(getOnlineCount は index.ts のハートビート数を渡す)
export function startDiscordReports(getOnlineCount: () => number): void {
  if (!WEBHOOK) {
    console.log('[Discord] DISCORD_WEBHOOK_URL 未設定のため定期通知は行いません');
    return;
  }
  console.log(`[Discord] ${INTERVAL_MIN}分ごとに在室レポートを送信します`);
  setInterval(() => {
    const count = getOnlineCount();
    const names = uniqueNames();
    if (!SEND_EMPTY && count === 0 && names.length === 0) return; // 無人のときは送らない
    void post(buildReport(count));
  }, INTERVAL_MIN * 60 * 1000);
}

// 任意タイミングで1回送る(テスト用API から使用)
export async function sendNow(onlineCount: number): Promise<boolean> {
  if (!WEBHOOK) return false;
  await post(buildReport(onlineCount));
  return true;
}
