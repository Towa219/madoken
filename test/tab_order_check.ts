// タブの並びを確かめる。
//
//   npm run dev を先に起こす
//   npx tsx test/tab_order_check.ts
//
// ★ 実際に画面へ描かれた順を読むこと。index.html を目で読んで
//   「合っている」と言うだけでは、CSS の order や JS の差し替えで
//   並びが変わっていても気づけない。
//
// ★ src/main.ts の TAB_BUTTONS とも突き合わせる。あちらには
//   「index.html の nav と同じにしておく」と書いてあるのに、
//   人が書き写す作りなので黙ってずれる。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9506;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// あるべき並び
const 期待 = ['研究室', '戦闘', 'ペット', '交易所', '発見図鑑', '説明書', '⚙ 設定'];

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

async function main(): Promise<void> {
  console.log('=== タブの並び ===');
  const profile = mkdtempSync(join(tmpdir(), 'madoken-tab-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1100,900', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!ws) { console.log('  NG  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const 待ち = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && 待ち.has(m.id)) { 待ち.get(m.id)!(m); 待ち.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; 待ち.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: PAGE });
    await sleep(5000);

    // ★ 左端からの座標で並べ直して読む。DOMの順ではなく、
    //   遊ぶ人が実際に見る順で確かめたい。
    const 実測 = await ev<string[]>(`(() => {
      const tabs = [...document.querySelectorAll('nav .tab')]
        .filter(b => !b.classList.contains('hidden'));
      return tabs
        .map(b => ({ x: b.getBoundingClientRect().x, t: (b.textContent || '').trim() }))
        .sort((a, b) => a.x - b.x)
        .map(o => o.t);
    })()`);

    console.log(`     実測: ${(実測 ?? []).join(' | ')}`);
    確認('画面に出ている並びが期待どおり',
      JSON.stringify(実測) === JSON.stringify(期待),
      JSON.stringify(実測) === JSON.stringify(期待) ? '' : `期待: ${期待.join(' | ')}`);

    const ペットの位置 = (実測 ?? []).indexOf('ペット');
    確認('ペットが戦闘と交易所の間にある',
      ペットの位置 > 0
      && 実測[ペットの位置 - 1] === '戦闘' && 実測[ペットの位置 + 1] === '交易所',
      ペットの位置 < 0 ? 'ペットが出ていない'
        : `${実測[ペットの位置 - 1] ?? '(無)'} → ペット → ${実測[ペットの位置 + 1] ?? '(無)'}`);

    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }

  // src/main.ts の写しとずれていないか
  const 本体 = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
  const 塊 = 本体.match(/const TAB_BUTTONS = \[([\s\S]*?)\]/)?.[1] ?? '';
  const 写し = [...塊.matchAll(/#tab-([a-z]+)/g)].map(m => m[1]);
  const 期待id = ['lab', 'battle', 'pet', 'shop', 'book', 'manual', 'settings'];
  確認('src/main.ts の TAB_BUTTONS も同じ並び',
    JSON.stringify(写し) === JSON.stringify(期待id),
    写し.join(','));

  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
