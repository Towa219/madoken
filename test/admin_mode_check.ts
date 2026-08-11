// 管理者モードが働くかを確かめる。
//
//   ADMIN_KEY=test1234 npm run start   … サーバーを鍵付きで起動しておく
//   npx tsx test/admin_mode_check.ts
//
// 見るのは4つ。
//   ・普段は「ペット」タブが出ていない
//   ・違う合言葉では入れない
//   ・正しい合言葉で入ると「ペット」タブが出る
//   ・抜けると消える
//
// ★ 合言葉の判定はサーバーに置いてある(このリポジトリは公開なので、
//   クライアント側に書くとソースを読めば誰でも突破できる)。
//   この検証も、サーバーが本当に弾いているかを見ている。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTTP = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const PORT = 9487;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 管理者モード ===');
  const profile = mkdtempSync(join(tmpdir(), 'adm-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1200,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!ws) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const wait = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; wait.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: HTTP });
    await sleep(5500);

    const petShown = () => ev<boolean>(
      '!document.querySelector("#tab-pet").classList.contains("hidden")');
    const check = async (label: string, want: boolean): Promise<void> => {
      const got = await petShown();
      if (got !== want) ng++;
      console.log(`  ${got === want ? 'OK ' : 'NG '} ${label}`);
    };

    await check('普段は「ペット」タブが出ていない', false);

    // 設定タブへ。まだ「管理者」の欄は隠れているはず
    await ev('document.querySelector("#tab-settings").click()');
    await sleep(900);
    const hiddenAtFirst = await ev<boolean>(
      'document.querySelector("#admin-panel").classList.contains("hidden")');
    if (!hiddenAtFirst) ng++;
    console.log(`  ${hiddenAtFirst ? 'OK ' : 'NG '} 普段は「管理者」の欄も隠れている`);

    // 隠しコマンド: 画面下の版番号を7回叩く
    await ev(`(() => {
      const f = document.querySelector('#app-footer');
      for (let i = 0; i < 7; i++) f.click();
    })()`);
    await sleep(500);
    const revealed = await ev<boolean>(
      '!document.querySelector("#admin-panel").classList.contains("hidden")');
    if (!revealed) ng++;
    console.log(`  ${revealed ? 'OK ' : 'NG '} 版番号を7回叩くと「管理者」が現れる`);

    await ev('document.querySelector("#btn-admin").click()');
    await sleep(400);

    // 違う合言葉
    await ev(`(() => {
      const i = document.querySelector('#admin-key');
      i.value = 'wrong-key-xxxx';
      document.querySelector('#btn-admin-go').click();
    })()`);
    await sleep(1800);
    await check('違う合言葉では入れない', false);
    const msg = await ev<string>('document.querySelector("#admin-msg").textContent');
    console.log(`     サーバーの返事: ${msg}`);

    // 正しい合言葉
    await ev(`(() => {
      const i = document.querySelector('#admin-key');
      i.value = ${JSON.stringify(KEY)};
      document.querySelector('#btn-admin-go').click();
    })()`);
    await sleep(1800);
    await check('正しい合言葉で「ペット」タブが出る', true);

    // 開ける
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(700);
    const opened = await ev<boolean>(
      '!document.querySelector("#pet-screen").classList.contains("hidden")');
    if (!opened) ng++;
    console.log(`  ${opened ? 'OK ' : 'NG '} 「ペット」画面が開く`);

    // 抜ける
    await ev('document.querySelector("#tab-settings").click()');
    await sleep(700);
    await ev('document.querySelector("#btn-admin-off").click()');
    await sleep(600);
    await check('抜けると「ペット」タブが消える', false);

    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
