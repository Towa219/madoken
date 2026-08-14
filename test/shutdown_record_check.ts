// 終了時に「終わり方の記録」がちゃんと書き終わってから死ぬかを測る。
//
//   npx tsx test/shutdown_record_check.ts
//
// ★ なぜ要るか(2026-08-14)。
//   本番で SIGTERM を受けても madoken:lastexit が一度も書かれず、
//   「書く暇もなく殺された=メモリ超過が濃厚」と読み違えるところだった。
//   実際の原因は順番で、Colyseus が既定で自前の SIGTERM を掴み、
//   部屋をたたんだ直後に process.exit を呼んでいた。在室0人だと
//   数ミリ秒で終わるので、Upstash への書き込み(往復100〜300ms)は
//   毎回間に合わない。
//
// ★ 測り方: 本物の Upstash は叩かない。わざと 400ms 遅れて返す
//   にせ Upstash を立て、「SETが届き、返事を返し終えてから
//   子プロセスが死んだか」を時刻で確かめる。遅れが無いと
//   競争にならず、壊れた作りでもたまたま受かってしまう。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ここ = dirname(fileURLToPath(import.meta.url));
const 遅らせる = 400;         // にせUpstashが返事を返すまでの時間(ms)
const にせポート = 2599;
const サーバーポート = 2568;

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

interface 記録 { 届いた: number; 返した: number; 中身: string }

async function main(): Promise<void> {
  console.log('=== 終わり方の記録は書き終わってから死ぬか ===');
  console.log(`  にせUpstashは ${遅らせる}ms 遅れて返事をします`);

  const 受けた: 記録[] = [];
  const にせ = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += String(c); });
    req.on('end', () => {
      const 届いた = Date.now();
      setTimeout(() => {
        受けた.push({ 届いた, 返した: Date.now(), 中身: body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      }, 遅らせる);
    });
  });
  await new Promise<void>(r => にせ.listen(にせポート, '127.0.0.1', () => r()));

  const 子 = spawn('npx', ['tsx', join(ここ, '_shutdown_probe.ts')], {
    cwd: join(ここ, '..'),
    shell: true,
    env: {
      ...process.env,
      PORT: String(サーバーポート),
      ADMIN_KEY: 'test1234',
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${にせポート}`,
      // ★ ここは必ず ASCII にすること。HTTPヘッダに載せる値なので、
      //   日本語を入れると fetch が投げて「書きに来なかった」に見える。
      UPSTASH_REDIS_REST_TOKEN: 'dummy-token',
      DISCORD_WEBHOOK_URL: '',
    },
  });

  let 出力 = '';
  子.stdout.on('data', d => { 出力 += String(d); });
  子.stderr.on('data', d => { 出力 += String(d); });

  const 死んだ = await new Promise<{ 時刻: number; code: number | null }>(resolve => {
    子.on('exit', code => resolve({ 時刻: Date.now(), code }));
    // 手順が詰まった時のための保険
    setTimeout(() => { 子.kill(); resolve({ 時刻: Date.now(), code: null }); }, 25_000);
  });

  にせ.close();

  const 終了記録 = 受けた.filter(r => r.中身.includes('madoken:lastexit'));
  確認('子プロセスが終了した', 死んだ.code !== null, `終了コード=${String(死んだ.code)}`);
  確認('終わり方の記録を書きに来た', 終了記録.length > 0,
    `Upstashへの書き込み ${受けた.length}件のうち lastexit は ${終了記録.length}件`);

  if (終了記録.length > 0) {
    const 記 = 終了記録[終了記録.length - 1];
    const 余裕 = 死んだ.時刻 - 記.返した;
    console.log(`     書き込みが届いた → 返事を返し終えた → 子が死んだ`);
    console.log(`     返事完了から終了まで ${余裕}ms`);
    確認('書き終えてから死んでいる', 余裕 >= 0,
      余裕 >= 0 ? `${余裕}ms 後に終了` : `${-余裕}ms 早く死んだ(書き込みを待っていない)`);
    const 中身 = (() => {
      try { return (JSON.parse(記.中身) as string[]).join(' '); } catch { return 記.中身; }
    })();
    確認('記録の中身が SIGTERM になっている', 中身.includes('SIGTERM'),
      中身.slice(0, 120));
  }

  確認('終了コードは0(異常終了ではない)', 死んだ.code === 0, `code=${String(死んだ.code)}`);

  if (ng > 0) {
    console.log('--- 子プロセスの出力(末尾) ---');
    console.log(出力.split('\n').slice(-25).join('\n'));
  }
  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
