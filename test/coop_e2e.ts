// E2Eテスト: 2クライアントでロビーチャット→共闘部屋→戦闘→決着まで検証
// 実行: npx tsx test/coop_e2e.ts (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const TIMEOUT_MS = 180_000; // 決闘はHP増加で長引くため余裕を持たせる

// ニックネームは登録簿で重複が弾かれるので、実行ごとに別名を使い、
// 終了時に解放して本番の登録簿を汚さないようにする(英数字のみ)
const RUN = Math.random().toString(36).slice(2, 7);
const NAME_A = `tA${RUN}`;
const NAME_B = `tB${RUN}`;
const TOKEN_A = `tok${RUN}A`;
const TOKEN_B = `tok${RUN}B`;
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');

async function releaseNames(): Promise<void> {
  for (const [name, token] of [[NAME_A, TOKEN_A], [NAME_B, TOKEN_B]]) {
    try {
      await fetch(`${HTTP_BASE}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token }),
      });
    } catch { /* 解放できなくてもテスト結果には影響しない */ }
  }
}

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
  const lobbyA = await clientA.joinOrCreate('lobby_chat', { name: NAME_A, nickToken: TOKEN_A });
  const lobbyB = await clientB.joinOrCreate('lobby_chat', { name: NAME_B, nickToken: TOKEN_B });
  lobbyB.onMessage('chat', (m: { name: string; text: string }) => {
    if (m.name === NAME_A && m.text === 'よろしく!') chatReceivedByB = true;
  });
  await sleep(300);
  lobbyA.send('chat', 'よろしく!');
  await waitFor(() => chatReceivedByB, 'チャット受信');
  ok('ロビーチャット: AのメッセージをBが受信');

  // ---- 1-2. ニックネームの重複拒否 ----
  const clientC = new Client(ENDPOINT);
  let nickRejected = false;
  try {
    await clientC.joinOrCreate('lobby_chat', { name: NAME_A, nickToken: 'tokX' });
  } catch {
    nickRejected = true;
  }
  if (!nickRejected) fail('他人が使用中のニックネームで入室できてしまった');
  ok('ニックネーム重複: 別端末が同じ名前で入室しようとして拒否された');

  // ---- 2. 共闘部屋の作成と参加 ----
  const spellsA = [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }];
  const spellsB = [{ name: '雷の魔弾', recipe: { thunder: 1, wind: 2 } }];

  const roomA: Room = await clientA.create('coop', {
    name: NAME_A, spells: spellsA, stage: 1, maxStage: 1, nickToken: TOKEN_A,
  });
  await sleep(300);
  const available = await clientB.getAvailableRooms('coop');
  if (available.length === 0) fail('部屋一覧に作成した部屋が出ない');
  ok(`部屋一覧取得: ${available.length}件 (stage=${(available[0].metadata as { stage?: number })?.stage})`);

  const roomB: Room = await clientB.joinById(available[0].roomId, {
    name: NAME_B, spells: spellsB, maxStage: 1, nickToken: TOKEN_B,
  });
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

  // ---- 5. 1人抜けても、残った人は続行できる ----
  // 以前は誰か1人が抜けると部屋全員のランを終わらせていた。
  // 回線が不調な人が1人いるだけで巻き添えが大きすぎたので、
  // 残っている人がいる限り続ける形に変えた(全員いなくなった時だけ中断)。
  let mateLeft: { name: string } | null = null;
  let abortedByB: { name: string } | null = null;
  roomB.onMessage('mateleft', (m: { name: string }) => { mateLeft = m; });
  roomB.onMessage('aborted', (m: { name: string }) => { abortedByB = m; });
  void roomA.leave();
  await waitFor(() => mateLeft !== null, '離脱の知らせ(mateleft)', 15_000);
  {
    const m = mateLeft as unknown as { name: string };
    if (m.name !== NAME_A) fail(`離脱者名が違う: ${m.name}`);
    ok(`Aの離脱がBに伝わった(${m.name})`);
  }
  if (abortedByB !== null) fail('残っている人がいるのにランが中断された');
  {
    const st = roomB.state as any;
    if (st?.phase !== 'fight') fail(`離脱後に戦闘が続いていない: phase=${st?.phase}`);
    ok('Bはそのまま戦闘を続けられる');
  }

  // ---- 6. 未到達ステージの部屋には入れない ----
  const roomHigh: Room = await clientA.create('coop', {
    name: NAME_A, spells: spellsA, stage: 5, maxStage: 5, nickToken: TOKEN_A,
  });
  let rejected = false;
  try {
    await clientB.joinById(roomHigh.roomId, { name: NAME_B, spells: spellsB, maxStage: 1, nickToken: TOKEN_B });
  } catch (e) {
    rejected = true;
    ok(`未到達ステージ5の部屋への参加を拒否: ${(e as Error).message}`);
  }
  if (!rejected) fail('未到達ステージの部屋に入れてしまった');
  void roomHigh.leave();

  // ---- 7. ボス戦は共闘部屋なら1人でも開始できる ----
  const bossRoom: Room = await clientA.create('coop', {
    name: NAME_A, spells: spellsA, stage: 5, maxStage: 5, nickToken: TOKEN_A,
  });
  bossRoom.send('ready');
  await sleep(1500);
  const bossPhase = (bossRoom.state as any)?.phase;
  if (bossPhase !== 'fight') {
    fail(`ボス戦が1人で開始しなかった(phase=${String(bossPhase)})`);
  }
  ok('ボスステージは共闘部屋なら1人でも開始する(phase=fight)');
  void bossRoom.leave();
  await sleep(300);

  // ---- 8. 決闘(PvP) ----
  const duelA: Room = await clientA.joinOrCreate('duel', { name: NAME_A, spells: spellsA, nickToken: TOKEN_A });
  const duelB: Room = await clientB.joinOrCreate('duel', { name: NAME_B, spells: spellsB, nickToken: TOKEN_B });
  await waitFor(() => (duelA.state as any)?.players?.size === 2, '決闘場に2人が入る');
  ok('決闘場に2人が入室');

  let duelEnd: { win: boolean } | null = null;
  duelA.onMessage('duelend', (m: { win: boolean }) => { duelEnd = m; });
  duelB.onMessage('duelend', () => { /* 相手側 */ });
  duelA.onMessage('dproj', () => { /* 弾 */ });
  duelA.onMessage('dhit', () => { /* 命中 */ });
  duelB.onMessage('dproj', () => { /* 弾 */ });
  duelB.onMessage('dhit', () => { /* 命中 */ });

  duelA.send('ready');
  duelB.send('ready');
  await waitFor(() => (duelA.state as any)?.phase === 'fight', '決闘開始(カウント後にfight)', 15_000);
  ok('両者準備完了→カウントダウン→決闘開始');

  const duelCaster = setInterval(() => {
    for (const room of [duelA, duelB]) {
      const st: any = room.state;
      const me = st?.players?.get(room.sessionId);
      if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
        room.send('cast', { idx: 0 });
      }
    }
  }, 400);
  await waitFor(() => duelEnd !== null, '決闘の決着', 90_000);
  clearInterval(duelCaster);
  ok(`決闘が決着(Aの結果: ${(duelEnd as unknown as { win: boolean }).win ? '勝ち' : '負け'})`);
  void duelB.leave();

  // ---- 9. 後片付け ----
  // leaveは投げっぱなし(本番のプロキシ経由では応答が返らず固まることがある)
  try {
    void roomB.leave();
    void lobbyA.leave();
    void lobbyB.leave();
  } catch { /* 切断済みでも無視 */ }
  await releaseNames(); // テスト用ニックネームを登録簿から消す
  clearTimeout(killer);
  console.log('\n★ E2Eテスト全項目合格');
  setTimeout(() => process.exit(0), 1500);
}

main().catch(err => {
  console.error('✗ 例外で失敗:', err);
  void releaseNames().finally(() => process.exit(1));
});
