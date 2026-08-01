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
import { persistent, removeScore, topRanking } from './ranking';
import { recentConnections } from './connlog';
import { discordEnabled, sendNow, startDiscordReports } from './discord';
import { presenceSnapshot } from './presence';
import { checkName, claimName, releaseName } from './names';
import { deleteSave, getSave, putSave } from './save';
import { BUILD_DATE, VERSION } from '../shared/version';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // クラウドセーブのため少し大きめ

// ランキングAPI(上位5件)
app.get('/api/ranking', (_req, res) => {
  void topRanking(5)
    .then(entries => res.json({ persistent, entries }))
    .catch(() => res.json({ persistent, entries: [] }));
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
  const b = req.body as { name?: unknown; token?: unknown; data?: unknown; savedAt?: unknown };
  void putSave(b?.name, b?.token, b?.data, Number(b?.savedAt) || Date.now())
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
  void sendNow(onlineCount())
    .then(ok => res.json({ sent: ok, enabled: discordEnabled }))
    .catch(() => res.json({ sent: false, enabled: discordEnabled }));
});

// ビルド済みクライアントを配信
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
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
