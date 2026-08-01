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
import { persistent, topRanking } from './ranking';
import { recentConnections } from './connlog';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

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

// プレイ中人数: クライアントが定期的に叩く簡易ハートビート
// (ロビー未接続でもページを開いていればカウントされる)
const heartbeats = new Map<string, number>();
const ALIVE_MS = 90_000;

app.get('/api/heartbeat', (req, res) => {
  const now = Date.now();
  const id = String(req.query.id ?? '').slice(0, 40);
  if (id) heartbeats.set(id, now);
  for (const [k, t] of heartbeats) {
    if (now - t > ALIVE_MS) heartbeats.delete(k);
  }
  res.json({ count: heartbeats.size });
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
});
