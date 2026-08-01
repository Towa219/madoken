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

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

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
