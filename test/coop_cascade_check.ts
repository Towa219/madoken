// 1人が切れた時、残った人が巻き添えで落ちないかを確かめる。
//
//   PORT=2568 ADMIN_KEY=test1234 npm run dev:server を先に起こす
//   PET_TEST_URL=http://localhost:2568 npx tsx test/coop_cascade_check.ts
//
// ★ 報告されている症状はこれ ―「一人落ちてから後の二人が続けて落ちた」。
//   サーバーの onLeave は「誰か残っていれば続行」と書いてあるが、
//   書いてあることと起きることが違うのはこれまで何度もあった。
//   実際に1人だけ切って、残りが生き残るところまで見る。
//
// ★ 待つ時間は RECONNECT_SEC より長くすること。サーバーは切れた人の席を
//   その秒数だけ空けて待つ。手前で打ち切ると「まだ待っているだけ」の
//   状態を見て「巻き添えは無い」と誤って結論する。

import { Client } from 'colyseus.js';
import { RECONNECT_SEC } from '../shared/data';
import { releaseTestNames } from './testnames';
import type { TestName } from './testnames';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2568';
const ステージ = Number(process.env.STAGE ?? 5);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const 使った名前: TestName[] = [];

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

const 魔法 = [{ name: '火の爆裂弾', recipe: { fire: 3 }, level: 9, rarity: 'legend' }];

interface 席 { 名: string; 部屋: any; 切れた: boolean; 理由: string }

async function main(): Promise<void> {
  console.log('=== 1人が切れた時の巻き添え ===');
  console.log(`  ${基点} / ステージ${ステージ} / サーバーが待つ秒数 ${RECONNECT_SEC}秒`);

  const 席たち: 席[] = [];
  let 部屋ID = '';
  try {
    for (let i = 0; i < 3; i++) {
      const 名 = `c${Math.random().toString(36).slice(2, 6)}`;
      使った名前.push({ name: 名, token: `tok_${名}` });
      const client = new Client(基点.replace(/^http/, 'ws'));
      const 入る = {
        name: 名, nickToken: `tok_${名}`, maxStage: 50,
        stage: ステージ, charId: i, spells: 魔法,
      };
      const 部屋 = i === 0
        ? await client.create('coop', 入る)
        : await client.joinById(部屋ID, 入る);
      if (i === 0) 部屋ID = 部屋.roomId;
      const s: 席 = { 名, 部屋, 切れた: false, 理由: '' };
      部屋.onLeave((code: number) => { s.切れた = true; s.理由 = `code=${code}`; });
      部屋.onError((code: number, m?: string) => { s.切れた = true; s.理由 = `error ${code} ${m ?? ''}`; });
      席たち.push(s);
      await sleep(300);
    }
    確認('3人が同じ部屋に入れた', 席たち.length === 3, `部屋 ${部屋ID}`);

    for (const s of 席たち) s.部屋.send('ready', {});
    let 相 = '';
    for (let i = 0; i < 150 && 相 !== 'fight'; i++) {
      await sleep(100);
      相 = (席たち[0].部屋.state as any)?.phase ?? '';
    }
    確認('戦闘が始まった', 相 === 'fight', `phase=${相}`);

    // 少し戦わせてから、1人だけ切る
    for (let i = 0; i < 8; i++) {
      for (const s of 席たち) { try { s.部屋.send('cast', { idx: 0 }); } catch { /* 切れた */ } }
      await sleep(500);
    }

    // ★ leave() ではなく、下の通信そのものを叩き落とす。
    //   leave() は「本人が退出した(consented)」扱いになり、サーバーは
    //   席を空けて待つ処理に入らない。回線が切れた時とは道が違うので、
    //   leave() で試すとこの検証は意味を失う。
    const 犠牲 = 席たち[0];
    const 生贄の接続 = (犠牲.部屋 as any).connection?.transport?.ws
      ?? (犠牲.部屋 as any).connection?.ws;
    if (生贄の接続 && typeof 生贄の接続.terminate === 'function') 生贄の接続.terminate();
    else if (生贄の接続 && typeof 生贄の接続.close === 'function') 生贄の接続.close();
    else { console.log('  NG  接続を叩き落とせなかった(内部の作りが変わった?)'); ng++; }
    console.log(`  ${犠牲.名} の接続を叩き落としました。`);

    // ★ サーバーが待つ秒数を越えて見る。手前で止めると
    //   「まだ待っている」だけの状態を見て誤って合格にする。
    const 見る秒 = RECONNECT_SEC + 25;
    for (let 経過 = 5; 経過 <= 見る秒; 経過 += 5) {
      await sleep(5000);
      for (const s of 席たち.slice(1)) {
        if (!s.切れた) { try { s.部屋.send('cast', { idx: 0 }); } catch { /* 切れた */ } }
      }
      const 相 = (席たち[1].部屋.state as any)?.phase ?? '(読めない)';
      const 生存 = 席たち.slice(1).filter(s => !s.切れた).length;
      console.log(`  ${経過}秒  相=${相}  残った2人のうち繋がっているのは${生存}人`);
      if (生存 === 0) break;
    }

    console.log('');
    for (const s of 席たち) {
      console.log(`  ${s.切れた ? '切れた' : '繋がったまま'}  ${s.名}${s.理由 ? ` (${s.理由})` : ''}`);
    }
    const 巻き添え = 席たち.slice(1).filter(s => s.切れた).length;
    確認('1人が切れても残りは巻き添えにならない', 巻き添え === 0,
      巻き添え > 0 ? `${巻き添え}人が続けて落ちた` : '2人とも繋がったまま');
  } finally {
    for (const s of 席たち) { try { await s.部屋.leave(); } catch { /* 済み */ } }
    await sleep(400);
    if (基点.includes('onrender.com')) await releaseTestNames(基点, 使った名前);
  }

  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  await sleep(500);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
