// iPhoneでダブルタップすると画面が拡大してしまう件を確かめる。
//
// 拡大を止めるのは touch-action: manipulation だが、これは
// 「継承されない」プロパティ。body に書いても中の要素には効かない。
// 効くのは指を置いた要素そのものの指定だけなので、
// タップがボタンの外(余白・枠・見出し・背景)に当たると今までどおり拡大する。
//
// 見るのは
//   ・画面の中に touch-action が auto(=拡大が起きる)のままの要素が無いか
//   ・指2本のピンチ拡大は残っているか(viewportで拡大を禁じていないか)
//
//   npx tsx test/tap_zoom_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9401;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      const fn = this.waiting.get(m.id);
      if (fn) { this.waiting.delete(m.id); fn(m); }
    };
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise(res => {
      this.waiting.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }

  // 指で触る。タッチを有効にしている間はマウスの合図が届かないので、
  // 実機と同じくタッチで押す(マウスにすると画面が切り替わらない)。
  async tap(sel: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!box) return false;
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x, y: box.y, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await sleep(60);
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    return true;
  }

  close(): void { this.ws.close(); }
}

// 見えている要素のうち、touch-action が auto のままのものを数える。
// auto = ブラウザ標準の扱い = ダブルタップで拡大する。
const SCAN = `
  (() => {
    const bad = [];
    let seen = 0;
    for (const e of document.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;   // 見えていないものは触れない
      seen++;
      const ta = getComputedStyle(e).touchAction;
      if (ta === 'auto') {
        const id = e.id ? '#' + e.id : '';
        const cls = e.className && typeof e.className === 'string'
          ? '.' + e.className.trim().split(/\\s+/).join('.') : '';
        bad.push(e.tagName.toLowerCase() + id + cls);
      }
    }
    return { seen, bad: bad.slice(0, 12), total: bad.length };
  })()
`;

interface Scan { seen: number; bad: string[]; total: number }

async function main(): Promise<void> {
  console.log('=== ダブルタップ拡大の抑止(iPhone想定) ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-tz-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) { check('ブラウザの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // iPhone 14 相当
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    // 指2本での拡大は残っていること(細かい字を読めなくなるのは困る)
    const vp = await cdp.evaluate<string>(
      'document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? ""');
    check('ピンチ拡大は禁じていない',
      !/user-scalable\s*=\s*(no|0)/.test(vp) && !/maximum-scale\s*=\s*1(\.0)?\b/.test(vp), vp);

    // 主な画面をひと通り回って、拡大が起きる要素が残っていないか見る
    const tabs: [string, string][] = [
      ['#tab-lab', '研究室'],
      ["#tab-book", "発見図鑑"],
      ['#tab-battle', '戦闘'],
      ['#tab-manual', '説明書'],
    ];
    for (const [sel, name] of tabs) {
      // 画面の切り替えは押した合図で行う。ここで見たいのはタブの押し心地では
      // なく、切り替わったあとの画面の中身なので、確実な方を選ぶ。
      const ok = await cdp.evaluate<boolean>(
        `(() => { const e = document.querySelector(${JSON.stringify(sel)});`
        + ` if (!e) return false; e.click(); return true; })()`);
      if (!ok) { console.log(`     (${name}のタブが見つからない)`); continue; }
      await sleep(900);
      // 本当に切り替わったか(切り替わっていないと同じ画面を4回見るだけになる)
      const active = await cdp.evaluate<string>(
        'document.querySelector(".tab.active")?.textContent ?? ""');
      const s = await cdp.evaluate<Scan>(SCAN);
      console.log(`     [${name}] 表示中のタブ=${active} / 見えている要素=${s.seen}`);
      check(`★${name}の画面に拡大が起きる要素が無い`, s.total === 0,
        s.total === 0
          ? `${s.seen}要素を確認`
          : `${s.total}件 残っている: ${s.bad.join(' / ')}`);
    }
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
