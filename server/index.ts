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
import { topRanking } from './ranking';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

// ランキングAPI(上位5件)
app.get('/api/ranking', (_req, res) => {
  res.json(topRanking(5));
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

httpServer.listen(port, () => {
  console.log(`[魔導研究記サーバー] ポート${port}で待機中 (http://localhost:${port})`);
});
