// ロビーの在室者と部屋の状況を一覧する診断スクリプト
// 実行: npx tsx test/who.ts  (本番を見るなら MADOKEN_ENDPOINT=wss://madoken.onrender.com)

import { Client } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';

async function main(): Promise<void> {
  const client = new Client(ENDPOINT);
  const lobby = await client.joinOrCreate('lobby_chat', { name: '観測者' });
  await new Promise(r => setTimeout(r, 1500));

  const st = lobby.state as { players?: { forEach(cb: (p: { name: string }, k: string) => void): void } };
  const names: string[] = [];
  st.players?.forEach((p, sid) => names.push(`${p.name} (${sid})`));

  console.log(`ロビー在室者: ${names.length}人`);
  for (const n of names) console.log(`  - ${n}`);

  for (const type of ['coop', 'duel']) {
    const rooms = await client.getAvailableRooms(type);
    console.log(`${type}ルーム: ${rooms.length}件`);
    for (const r of rooms) {
      console.log(`  - ${r.roomId} ${r.clients}/${r.maxClients}人 meta=${JSON.stringify(r.metadata)}`);
    }
  }

  void lobby.leave();
  setTimeout(() => process.exit(0), 800);
}

main().catch(e => { console.error(e); process.exit(1); });
