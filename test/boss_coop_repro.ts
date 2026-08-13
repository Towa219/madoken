// ボス戦で切断が起きるかを、実際に戦って確かめる。
//
//   ADMIN_KEY=test1234 npm run dev:server を先に起こす
//   npx tsx test/boss_coop_repro.ts [人数]
//
// ★ ブラウザを使わない。切断が「サーバーが落ちている」のか
//   「その端末だけ切れている」のかを分けたいので、素の接続で見る。
//   サーバーが落ちていれば、戦っていない別の接続も同時に切れる。
//
// ★ 戦っていない「見張り役」を1つ余分に繋いでおく。
//   これが同時に切れたらサーバーが落ちた証拠。切れなければ
//   その部屋・その端末だけの問題ということになる。

import { Client } from 'colyseus.js';
import { releaseTestNames } from './testnames';
import type { TestName } from './testnames';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2567';
const 人数 = Math.max(1, Math.min(4, Number(process.argv[2] ?? 1)));
const ステージ = Number(process.env.STAGE ?? 5);   // 5の倍数=ボス
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 強い魔法を1本。ボスを現実的な時間で削るため。
const 魔法 = [{ name: '火の爆裂弾', recipe: { fire: 3 }, level: 9, rarity: 'legend' }];

interface 記録 { 名: string; 切れた: boolean; 理由: string }

// 本番へ向けた時に片づける名前
const 使った名前: TestName[] = [];

async function main(): Promise<void> {
  console.log('=== ボス戦の切断を再現する ===');
  console.log(`  接続先: ${基点} / ステージ${ステージ} / ${人数}人`);

  // ---- 見張り役(ロビーに居るだけ。戦闘には入らない) ----
  const 見張り名 = `m${Math.random().toString(36).slice(2, 6)}`;
  使った名前.push({ name: 見張り名, token: `tok_${見張り名}` });
  let 見張り切れた = false;
  let 見張り理由 = '';
  const 見張り = await new Client(基点.replace(/^http/, 'ws'))
    .joinOrCreate('lobby_chat', { name: 見張り名, nickToken: `tok_${見張り名}` })
    .catch((e: Error) => { console.log(`  (見張りは繋げなかった: ${e.message})`); return null; });
  if (見張り) {
    見張り.onLeave(code => { 見張り切れた = true; 見張り理由 = `code=${code}`; });
    見張り.onError((code, msg) => { 見張り切れた = true; 見張り理由 = `error ${code} ${msg}`; });
  }

  // ---- 戦う人たち ----
  const 記録たち: 記録[] = [];
  const 部屋たち: any[] = [];
  let 部屋ID = '';
  for (let i = 0; i < 人数; i++) {
    const 名 = `b${Math.random().toString(36).slice(2, 6)}`;
    使った名前.push({ name: 名, token: `tok_${名}` });
    const client = new Client(基点.replace(/^http/, 'ws'));
    const 入る = { name: 名, nickToken: `tok_${名}`, maxStage: 50, stage: ステージ, charId: i % 6, spells: 魔法 };
    const 部屋 = i === 0
      ? await client.create('coop', 入る)
      : await client.joinById(部屋ID, 入る);
    if (i === 0) 部屋ID = 部屋.roomId;
    const rec: 記録 = { 名, 切れた: false, 理由: '' };
    部屋.onLeave((code: number) => { rec.切れた = true; rec.理由 = `code=${code}`; });
    部屋.onError((code: number, msg?: string) => { rec.切れた = true; rec.理由 = `error ${code} ${msg ?? ''}`; });
    記録たち.push(rec); 部屋たち.push(部屋);
    await sleep(200);
  }
  console.log(`  部屋を作った: ${部屋ID}(${部屋たち.length}人)`);

  // ---- 戦闘開始 ----
  for (const 部屋 of 部屋たち) 部屋.send('ready', {});
  const 状態 = () => (部屋たち[0].state as any);
  let 相 = '';
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    相 = 状態()?.phase ?? '';
    if (相 === 'fight') break;
  }
  console.log(`  開始時の相: ${相}`);

  // ---- 倒れるまで撃ち続ける ----
  const 始め = Date.now();
  let 最後の相 = 相;
  let 経過秒 = 0;
  while (Date.now() - 始め < 120_000) {
    await sleep(400);
    経過秒 = Math.round((Date.now() - 始め) / 1000);
    if (記録たち.some(r => r.切れた) || 見張り切れた) break;
    const st = 状態();
    最後の相 = st?.phase ?? '(読めない)';
    if (最後の相 === 'fight') {
      for (const 部屋 of 部屋たち) { try { 部屋.send('cast', { idx: 0 }); } catch { /* 切れた */ } }
    }
    if (最後の相 === 'done') break;
    // clear のあと4秒で次ステージへ自動で進む。ボスを1回倒せれば目的は足りる。
    if (最後の相 === 'clear') { await sleep(6000); break; }
  }

  const 敵 = (状態()?.enemies ?? []) as any[];
  console.log(`  ${経過秒}秒後の相: ${最後の相} / 敵の残り: `
    + (敵.length ?敵.map((e: any) => `${Math.round(e.hp)}`).join(',') : '(無し)'));

  console.log('');
  console.log('  --- 切れたかどうか ---');
  for (const r of 記録たち) {
    console.log(`  ${r.切れた ? '切れた' : '繋がったまま'}  戦った人 ${r.名}${r.理由 ? ` (${r.理由})` : ''}`);
  }
  console.log(`  ${見張り切れた ? '切れた' : '繋がったまま'}  見張り(戦っていない)`
    + `${見張り理由 ? ` (${見張り理由})` : ''}`);

  // サーバー自体が生きているかを別口で確かめる
  const 生死 = await fetch(`${基点}/api/version`).then(r => r.status).catch(() => 0);
  console.log(`  サーバーの応答: ${生死 === 0 ? '返ってこない(落ちている)' : `HTTP ${生死}`}`);

  console.log('');
  if (見張り切れた) {
    console.log('=> 戦っていない見張りも切れた。**サーバーが落ちている**。');
  } else if (記録たち.some(r => r.切れた)) {
    console.log('=> 戦った人だけ切れた。サーバーは生きている(部屋か端末の問題)。');
  } else {
    console.log('=> 誰も切れなかった。この手順では再現しない。');
  }

  for (const 部屋 of 部屋たち) { try { await 部屋.leave(); } catch { /* 既に切れている */ } }
  try { await 見張り?.leave(); } catch { /* 同上 */ }

  // ★ 本番へ向けた時は必ず片づける。入室時に名前が予約されるので、
  //   放っておくと架空の名前が本物の登録に残る(過去に順位表へ
  //   居座らせた事故がある)。
  await releaseTestNames(基点, 使った名前);

  // すぐ終わらせない。閉じかけの通信を抱えたまま process.exit すると
  // libuv が「閉じている最中の handle」に触って落ちる(実際に出た)。
  await sleep(800);
}

void main();
