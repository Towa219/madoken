// ゲームサーバー本体: 静的配信(dist) + Colyseus(ロビーチャット/共闘)

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'node:path';
// colyseus系はCJSパッケージのため、Node ESMではデフォルトimport経由で取り出す
import colyseusPkg from 'colyseus';
import wsTransportPkg from '@colyseus/ws-transport';
import { LobbyChatRoom } from './rooms/LobbyChatRoom';
import { CoopRoom } from './rooms/CoopRoom';
import { DuelRoom } from './rooms/DuelRoom';
import { magicRankScore, persistent, removeScore, submitScore, topRanking } from './ranking';
import { banName, bannedNames, unbanName } from './banlist';
import { recentConnections } from './connlog';
import { buildReport, discordEnabled, sendNow, startDiscordReports } from './discord';
import { presenceSnapshot } from './presence';
import { checkName, claimName, forceReleaseName, releaseName } from './names';
import { deleteSave, getSave, putSave } from './save';
import { BUILD_DATE, VERSION } from '../shared/version';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // クラウドセーブのため少し大きめ

// ランキングAPI(上位3件)
app.get('/api/ranking', (_req, res) => {
  void topRanking(3)
    .then(entries => res.json({ persistent, entries }))
    .catch(() => res.json({ persistent, entries: [] }));
});

// ===== ランキングの管理(ADMIN_KEY が要る) =====
//
// 不適切な名前が載った時に、記録を消して名前そのものを塞ぐための入口。
// 消すだけでは同じ名前で登録し直せてしまうので、禁止名の一覧も持つ。
//
//   一覧   GET  /api/admin/ranking?key=KEY
//   削除   POST /api/admin/ranking/remove  {key, name, ban}
//   禁止名 GET  /api/admin/ban?key=KEY
//          POST /api/admin/ban  {key, name, action: 'add' | 'remove'}
function adminOk(req: express.Request, res: express.Response): boolean {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(403).json({ error: 'ADMIN_KEY が未設定です(Renderの環境変数に足してください)' });
    return false;
  }
  const given = String(req.query.key ?? (req.body as { key?: unknown })?.key ?? '');
  if (given !== adminKey) {
    res.status(403).json({ error: 'キーが違います' });
    return false;
  }
  return true;
}

app.get('/api/admin/ranking', (req, res) => {
  if (!adminOk(req, res)) return;
  const n = Math.max(1, Math.min(200, Math.floor(Number(req.query.n) || 100)));
  void topRanking(n)
    .then(entries => res.json({ persistent, count: entries.length, entries }))
    .catch(() => res.json({ persistent, count: 0, entries: [] }));
});

app.post('/api/admin/ranking/remove', (req, res) => {
  if (!adminOk(req, res)) return;
  const body = req.body as { name?: unknown; ban?: unknown };
  const name = String(body?.name ?? '');
  if (!name) { res.status(400).json({ error: '名前が空です' }); return; }
  void (async () => {
    await removeScore(name);
    // 名前を塞ぐ場合は、持ち主の予約も外す。
    // 外さないと、その人の端末からは同じ名前で入り続けられる。
    let banned = '';
    if (body?.ban) {
      banned = await banName(name);
      await forceReleaseName(name);
    }
    res.json({ ok: true, removed: name, banned: banned || null });
  })().catch(() => res.status(500).json({ error: '削除に失敗しました' }));
});

app.get('/api/admin/ban', (req, res) => {
  if (!adminOk(req, res)) return;
  void bannedNames()
    .then(names => res.json({ count: names.length, names }))
    .catch(() => res.json({ count: 0, names: [] }));
});

app.post('/api/admin/ban', (req, res) => {
  if (!adminOk(req, res)) return;
  const body = req.body as { name?: unknown; action?: unknown };
  const name = String(body?.name ?? '');
  const action = String(body?.action ?? 'add');
  if (!name) { res.status(400).json({ error: '名前が空です' }); return; }
  void (async () => {
    if (action === 'remove') {
      res.json({ ok: true, unbanned: await unbanName(name) });
      return;
    }
    const banned = await banName(name);
    await removeScore(name);
    await forceReleaseName(name);
    res.json({ ok: true, banned });
  })().catch(() => res.status(500).json({ error: '操作に失敗しました' }));
});

// 接続ログの閲覧(管理用)。ADMIN_KEY 環境変数を設定した場合のみ有効。
// 設定しない場合でも、接続は標準出力に流れるのでRenderのログ画面で読める。
app.get('/api/connlog', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(403).json({
      error: 'ADMIN_KEY未設定のため無効。Renderのログ画面で「[接続]」の行を確認してください。',
    });
    return;
  }
  if (String(req.query.key ?? '') !== adminKey) {
    res.status(403).json({ error: 'キーが違います' });
    return;
  }
  const n = Math.max(1, Math.min(200, Math.floor(Number(req.query.n) || 50)));
  void recentConnections(n)
    .then(entries => res.json({ entries }))
    .catch(() => res.json({ entries: [] }));
});

// 魔導値ランキングへの登録。
//
// スコアはサーバーで計算し直す。クライアントが送ってくるのはレシピ・強化Lv・品質
// だけで、魔導値の申告は受け取らない。受け取ると、いくらでも詐称できてしまう。
app.post('/api/ranking/submit', (req, res) => {
  const body = req.body as {
    name?: unknown; nickToken?: unknown; spells?: unknown; bossCleared?: unknown;
    charId?: unknown;
  };
  void (async () => {
    // 名前の持ち主であることを確認する(他人の名前で登録させない)
    const r = await claimName(body?.name, body?.nickToken);
    if (!r.ok) {
      res.status(403).json({ ok: false, error: r.error ?? '名前を確認できません' });
      return;
    }
    const score = magicRankScore(body?.spells, body?.bossCleared, body?.charId);
    submitScore(String(body?.name ?? ''), score.total, score.names);
    res.json({ ok: true, score: score.total });
  })().catch(() => res.status(500).json({ ok: false, error: '登録に失敗しました' }));
});

// ===== ニックネーム登録簿(重複防止) =====

// 入力欄の事前チェック(登録はしない)
app.get('/api/name/check', (req, res) => {
  void checkName(req.query.name, req.query.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: true }));
});

// 名前を確保する(初回接続時)
app.post('/api/name/claim', (req, res) => {
  const body = req.body as { name?: unknown; token?: unknown };
  void claimName(body?.name, body?.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: true }));
});

// 名前を手放す(キャラ初期化時)。所有者本人のときだけ消える。
// 同時にランキングの記録も消す(次にその名前を取った人の記録と混ざらないように)。
app.post('/api/name/release', (req, res) => {
  const body = req.body as { name?: unknown; token?: unknown };
  void releaseName(body?.name, body?.token)
    .then(async released => {
      if (released) await removeScore(String(body?.name ?? ''));
      res.json({ released });
    })
    .catch(() => res.json({ released: false }));
});

// ===== サーバー側セーブ(クラウドセーブ) =====

// 保存(ニックネーム+引き継ぎコードが本人のものであること)
app.post('/api/save', (req, res) => {
  const b = req.body as {
    name?: unknown; token?: unknown; data?: unknown; savedAt?: unknown; force?: unknown;
  };
  void putSave(b?.name, b?.token, b?.data, Number(b?.savedAt) || Date.now(), b?.force === true)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: false, error: '保存に失敗しました。' }));
});

// 読み込み(別の端末への引き継ぎもこれ)
app.post('/api/load', (req, res) => {
  const b = req.body as { name?: unknown; token?: unknown };
  void getSave(b?.name, b?.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: false, error: '読み込みに失敗しました。' }));
});

// 削除(キャラ初期化時)
app.post('/api/save/delete', (req, res) => {
  const b = req.body as { name?: unknown; token?: unknown };
  void deleteSave(b?.name, b?.token)
    .then(deleted => res.json({ deleted }))
    .catch(() => res.json({ deleted: false }));
});

// プレイ中人数: クライアントが定期的に叩く簡易ハートビート
// (ロビー未接続でもページを開いていればカウントされる)
const heartbeats = new Map<string, number>();
const ALIVE_MS = 90_000;

function onlineCount(): number {
  const now = Date.now();
  for (const [k, t] of heartbeats) {
    if (now - t > ALIVE_MS) heartbeats.delete(k);
  }
  return heartbeats.size;
}

app.get('/api/heartbeat', (req, res) => {
  const id = String(req.query.id ?? '').slice(0, 40);
  if (id) heartbeats.set(id, Date.now());
  res.json({ count: onlineCount() });
});

// 眠らせないための叩き先(外部のcronが遊ばれる時間帯だけ定期的に呼ぶ)。
//
// 無料プランは15分アクセスが無いと眠り、起こすのに30〜60秒かかる。
// 人が遊んでいる間はその人の通信で15分が延び続けるので、叩く目的は
// 「最初の1人が来た時にはもう起きている」状態を作ることだけ。
// だから24時間叩く必要はない ― 枠(月750時間)を使い切ると
// 翌月まで停止するので、時間帯を絞るほうが安全。
//
// uptime を返しているのは、叩けているかを後から確かめるため。
// 呼ぶたびに増えていれば一度も眠っていない。小さくなっていたら、
// その間に眠って起こし直された = cronに穴がある(入れ替えの直後は除く)。
//   確認: npx tsx test/awake_check.ts
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), version: VERSION });
});

// サーバーの稼働状態(秘密情報は含めない・動作確認用)
app.get('/api/status', (_req, res) => {
  res.json({
    version: VERSION,
    build: BUILD_DATE,
    rankingPersistent: persistent,
    discordEnabled,
    online: onlineCount(),
    rooms: presenceSnapshot().map(r => ({
      type: r.type, label: r.label, count: r.names.length,
    })),
  });
});

// Discordへ今すぐ1回送る(ADMIN_KEY必須・動作確認用)
app.get('/api/discord-test', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || String(req.query.key ?? '') !== adminKey) {
    res.status(403).json({ error: 'ADMIN_KEYが必要です' });
    return;
  }
  // 送るだけでなく本文も返す。Webhook未設定の環境でも中身を確かめられる。
  void Promise.all([sendNow(onlineCount()), buildReport(onlineCount())])
    .then(([sent, text]) => res.json({ sent, enabled: discordEnabled, text }))
    .catch(() => res.json({ sent: false, enabled: discordEnabled }));
});

// ビルド済みクライアントを配信
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

const httpServer = createServer(app);

const gameServer = new Server({
  // 既定値は ping 3秒 × 2回 = 約6秒の無応答で切断。これは厳しすぎる。
  // スマホの画面を消した、電波が一瞬途切れた、PCがスリープしかけた程度で
  // 戦闘中に切られてしまう。25秒まで待つようにした。
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 5000,
    pingMaxRetries: 5,
  }),
});

gameServer.define('lobby_chat', LobbyChatRoom);
gameServer.define('coop', CoopRoom);
gameServer.define('duel', DuelRoom);

httpServer.listen(port, () => {
  console.log(`[魔導研究記サーバー] ポート${port}で待機中 (http://localhost:${port})`);
  console.log(
    persistent
      ? '[ランキング] Upstashに恒久保存します'
      : '[ランキング] 一時保存(再起動でリセット)。UPSTASH_REDIS_REST_URL/TOKEN未設定',
  );
  startDiscordReports(onlineCount);
});
