// E2Eテスト: 2クライアントでロビーチャット→共闘部屋→戦闘→決着まで検証
// 実行: npx tsx test/coop_e2e.ts (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const TIMEOUT_MS = 90_000;

function fail(msg: string): never {
  console.error(`✗ 失敗: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) fail(`${what} がタイムアウト`);
    await sleep(100);
  }
}

async function main(): Promise<void> {
  const killer = setTimeout(() => fail('テスト全体がタイムアウト'), TIMEOUT_MS);

  // ---- 1. ロビーチャット ----
  const clientA = new Client(ENDPOINT);
  const clientB = new Client(ENDPOINT);

  let chatReceivedByB = false;
  const lobbyA = await clientA.joinOrCreate('lobby_chat', { name: 'テストA' });
  const lobbyB = await clientB.joinOrCreate('lobby_chat', { name: 'テストB' });
  lobbyB.onMessage('chat', (m: { name: string; text: string }) => {
    if (m.name === 'テストA' && m.text === 'よろしく!') chatReceivedByB = true;
  });
  await sleep(300);
  lobbyA.send('chat', 'よろしく!');
  await waitFor(() => chatReceivedByB, 'チャット受信');
  ok('ロビーチャット: AのメッセージをBが受信');

  // ---- 2. 共闘部屋の作成と参加 ----
  const spellsA = [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }];
  const spellsB = [{ name: '雷の魔弾', recipe: { thunder: 1, wind: 2 } }];

  const roomA: Room = await clientA.create('coop', { name: 'テストA', spells: spellsA, stage: 1 });
  await sleep(300);
  const available = await clientB.getAvailableRooms('coop');
  if (available.length === 0) fail('部屋一覧に作成した部屋が出ない');
  ok(`部屋一覧取得: ${available.length}件 (stage=${(available[0].metadata as { stage?: number })?.stage})`);

  const roomB: Room = await clientB.joinById(available[0].roomId, { name: 'テストB', spells: spellsB });
  ok('Bが部屋に参加');

  const events = {
    hits: 0, projs: 0,
    clearA: null as null | { stage: number; rp: number; drops: string[] },
    clearB: null as null | { stage: number },
    resultA: null as null | { win: boolean; rp: number; drops: string[] },
  };
  for (const room of [roomA, roomB]) {
    room.onMessage('hit', () => { events.hits++; });
    room.onMessage('proj', () => { events.projs++; });
    room.onMessage('eproj', () => { /* 敵の攻撃 */ });
    room.onMessage('phit', () => { /* 被弾 */ });
    room.onMessage('heal', () => { /* 回復 */ });
    room.onMessage('shieldup', () => { /* 護盾 */ });
    room.onMessage('shieldhit', () => { /* 護盾被弾 */ });
  }
  roomA.onMessage('stageclear', (m: { stage: number; rp: number; drops: string[] }) => { events.clearA = m; });
  roomB.onMessage('stageclear', (m: { stage: number }) => { events.clearB = m; });
  roomA.onMessage('result', (m: { win: boolean; rp: number; drops: string[] }) => { events.resultA = m; });
  roomB.onMessage('result', () => { /* 全滅時 */ });

  // ---- 3. 準備完了→戦闘開始 ----
  await waitFor(() => {
    const st: any = roomA.state;
    return st?.players?.size === 2;
  }, '2人がステートに反映');
  ok('2人ともステートに反映された');

  roomA.send('ready');
  await sleep(300);
  {
    const st: any = roomA.state;
    if (st.phase !== 'ready') fail('片方だけreadyで開始してしまった');
  }
  roomB.send('ready');
  await waitFor(() => (roomA.state as any)?.phase === 'fight', '戦闘開始');
  ok('全員準備完了で戦闘開始(phase=fight)');
  {
    const st: any = roomA.state;
    if (st.enemies.length === 0) fail('敵が出現していない');
    const e = st.enemies[0];
    ok(`敵出現: ${e.name} HP${e.hp}(2人分の増強込み)`);
  }

  // ---- 4. 戦闘: 両者が魔法0番を撃ち続ける ----
  const caster = setInterval(() => {
    for (const room of [roomA, roomB]) {
      const st: any = room.state;
      const me = st?.players?.get(room.sessionId);
      if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
        room.send('cast', { idx: 0 });
      }
    }
  }, 400);

  await waitFor(() => events.clearA !== null && events.clearB !== null, 'ステージ1クリア(stageclear受信)', 60_000);

  if (events.projs === 0) fail('弾イベント(proj)が飛んでいない');
  if (events.hits === 0) fail('ダメージイベント(hit)が発生していない');
  ok(`戦闘ログ: proj=${events.projs}回, hit=${events.hits}回`);
  const cA = events.clearA!;
  ok(`ステージ${cA.stage}クリア: 研究P+${cA.rp}, ドロップ=[${cA.drops.join(',')}] を両者が受信`);

  // 自動で次ステージへ進むことを確認
  await waitFor(() => {
    const st: any = roomA.state;
    return st?.stage === 2 && st?.phase === 'fight' && st?.enemies?.length > 0;
  }, '次ステージ自動開始(stage=2, fight)', 15_000);
  clearInterval(caster);
  {
    const st: any = roomA.state;
    let allAlive = true;
    st.players.forEach((p: any) => { if (!p.alive) allAlive = false; });
    if (!allAlive) fail('次ステージ開始時に復活していないプレイヤーがいる');
  }
  ok('ステージ2が自動開始され、全員生存状態で継続');

  // ---- 5. 後片付け ----
  await roomA.leave();
  await roomB.leave();
  await lobbyA.leave();
  await lobbyB.leave();
  clearTimeout(killer);
  console.log('\n★ E2Eテスト全項目合格');
  process.exit(0);
}

main().catch(err => {
  console.error('✗ 例外で失敗:', err);
  process.exit(1);
});
