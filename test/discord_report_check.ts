// Discordに送る在室レポートの中身を確認する(実際には送信しない)

import { logConnection } from '../server/connlog';
import { setRoomPresence } from '../server/presence';
import { buildReport } from '../server/discord';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  // 接続を2件記録(地域・回線はip-api.comで推定される)
  logConnection('ロビー', 'ゆりパパ', '8.8.8.8');
  logConnection('共闘(ステージ3)', '魔導士ノ王', '1.1.1.1');
  await sleep(2500); // 地域推定の応答待ち

  setRoomPresence('room1', 'ロビー', '', ['ゆりパパ']);
  setRoomPresence('room2', '共闘', 'ステージ3', ['魔導士ノ王']);

  console.log('===== Discordへ送る本文 =====');
  console.log(buildReport(2));
  console.log('=============================');
}

void main();
