// 説明書の「ペット」の節が、実画面でどう見えるかを撮る。
//
//   npm run dev  … 先に開発サーバーを起こす
//   npx tsx test/manual_pet_shot.ts
//
// ★ 数字が shared/pets.ts から引かれているかを目でも確かめる。
//   説明書に手で書いた数字は必ず古くなる(錬成の説明とMP回復で実際に
//   起きた)。ここでは「表に出ている数字」と「定義の数字」を突き合わせる。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PETS, PET_SPECIES, BREED_MAX_COUNT, DEAD_KEEP_DAYS, PETS_PUBLIC,
} from '../shared/pets';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9494;
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const OUT = join(process.cwd(), 'tools', 'shots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 説明書のペットの節 ===');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'man-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1000,1200', 'about:blank',
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
      const m = JSON.parse(String(e.data)) as { id?: number };
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
    await send('Page.navigate', { url: URL_ });
    await sleep(5000);

    // ★ まず一般の目で見る。公開していない機能の説明が読めてはいけない。
    //   タブは管理者にしか出ないので、説明だけ見えると
    //   「ペットってどこにあるの?」になる。
    await ev('document.querySelector("#tab-manual").click()');
    await sleep(1200);
    const 一般に見えるか = await ev<boolean>(`(() => {
      return [...document.querySelectorAll('.man-sec')]
        .some(x => (x.querySelector('h3')?.textContent || '').includes('ペット'));
    })()`);
    const 一般の期待 = PETS_PUBLIC;
    if (一般に見えるか !== 一般の期待) ng++;
    console.log(`  ${一般に見えるか === 一般の期待 ? 'OK ' : 'NG '} `
      + `公開の旗が${PETS_PUBLIC ? '上がって' : '下りて'}いる時、一般には`
      + `${一般の期待 ? '見える' : '見えない'} → 実測 ${一般に見えるか ? '見えた' : '見えない'}`);

    // 管理者になってから見る
    await ev(`(() => {
      try { sessionStorage.setItem('madoken_admin_key', ${JSON.stringify(KEY)}); } catch {}
      location.reload();
    })()`);
    await sleep(5500);
    await ev('document.querySelector("#tab-manual").click()');
    await sleep(1200);

    const 本文 = await ev<string>(`(() => {
      const secs = [...document.querySelectorAll('.man-sec')];
      const s = secs.find(x => (x.querySelector('h3')?.textContent || '').includes('ペット'));
      if (!s) return '';
      s.scrollIntoView();
      return s.textContent.replace(/\\s+/g, ' ');
    })()`);

    if (!本文) { console.log('  NG  管理者でもペットの節が見つからない'); ng++; }
    else {
      console.log(`  OK  ペットの節がある(${本文.length}文字)`);
      // 定義の数字が本文に出ているか
      const 見る: [string, string][] = [
        [`${MAX_PETS}羽`, '手持ちの上限'],
        [`${BREED_MAX_COUNT}回`, '交配の生涯回数'],
        [`${DEAD_KEEP_DAYS}日`, '天へ行った子を残す日数'],
        [`+${PET_SPECIES.hawk.hp}`, 'タカのHP'],
        [`+${PET_SPECIES.owl.mp}`, 'フクロウのMP'],
      ];
      for (const [語, 何] of 見る) {
        const ある = 本文.includes(語);
        if (!ある) ng++;
        console.log(`  ${ある ? 'OK ' : 'NG '} ${何}が定義どおり出ている(${語})`);
      }
      // ★ アオイトリは伏せる。名前が出ていたら台無し
      const 漏れ = 本文.includes(PET_SPECIES.bluebird.name);
      if (漏れ) ng++;
      console.log(`  ${漏れ ? 'NG ' : 'OK '} ごく稀の鳥の名前が説明書に出ていない`);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'manual_pet.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/manual_pet.png');
    }
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
