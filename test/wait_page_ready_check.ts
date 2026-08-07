// 待機ページを「サーバーが既に起きている状態」で開いた時の挙動を見る。
//
// test/wait_page_check.ts は眠っている状態(通信を塞ぐ)を見ている。
// こちらはその逆で、起きている時に起きること:
//
//   ・いきなりゲームへ飛ばされない
//     (実際に1秒たらずで飛んで、予告編を押す間もなかった)
//   ・「ゲームを始める」と「予告編を見る」が選べる
//   ・★ 何度開いても同じであること
//     「初めての人だけ止める」にしたら、一度通った人は二度と
//     予告編に辿り着けなくなった。同じ穴に落ちないよう2回見る。
//   ・押すまで勝手に進まない
//
//   npx tsx test/wait_page_ready_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WAIT_URL = process.env.MADOKEN_WAIT_URL ?? 'https://towa219.github.io/madoken/';
const GAME_HOST = 'madoken.onrender.com';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9431;

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

  async click(sel: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e || e.disabled) return null;
        const r = e.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(300);
    return true;
  }

  close(): void { this.ws.close(); }
}

const HERE = 'location.href';

async function open(cdp: Cdp): Promise<void> {
  await cdp.send('Page.navigate', { url: WAIT_URL });
  for (let i = 0; i < 60; i++) {
    const done = await cdp.evaluate<boolean>(
      'document.readyState === "complete" && location.href.indexOf("about:blank") < 0');
    if (done) break;
    await sleep(200);
  }
}

async function main(): Promise<void> {
  console.log('=== 待機ページ(サーバーが起きている時) ===');
  console.log(`対象: ${WAIT_URL}`);

  // 先に本体を起こしておく。眠っていると、この検証の前提が崩れる。
  const t0 = Date.now();
  try {
    await fetch(`https://${GAME_HOST}/api/ping`, { cache: 'no-store' });
  } catch { /* 起こせなくても下で分かる */ }
  console.log(`     本体の応答: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-wr-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=520,900', 'about:blank',
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
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 520, height: 900, deviceScaleFactor: 2, mobile: true });

    // ---- 1回目(初めての人) ----
    await open(cdp);
    await sleep(3000);
    check('★起きていても、いきなりゲームへ飛ばされない',
      (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0,
      await cdp.evaluate<string>(HERE));
    check('★「準備ができました」と出る',
      (await cdp.evaluate<string>('document.getElementById("lead").textContent ?? ""'))
        .indexOf('準備ができました') >= 0);
    check('「ゲームを始める」が押せる状態で出ている',
      await cdp.evaluate<boolean>(
        '!document.getElementById("ready").classList.contains("hidden")'));
    check('予告編のボタンも出ている',
      await cdp.evaluate<boolean>(
        'document.getElementById("btn-pv").getBoundingClientRect().width > 0'));

    // しばらく置いても、押すまで進まないこと
    await sleep(9000);
    check('★押すまで勝手にゲームへ進まない',
      (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0,
      await cdp.evaluate<string>(HERE));

    // 予告編を開いて閉じても、まだ入口に留まる
    check('予告編を開ける', await cdp.click('#btn-pv'));
    await sleep(3000);
    check('予告編が開く',
      await cdp.evaluate<boolean>(
        '!document.getElementById("pv-modal").classList.contains("hidden")'));
    await cdp.click('#btn-pv-close');
    await sleep(1500);
    check('閉じても入口に留まる',
      (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0);

    // 押したらゲームへ
    check('「ゲームを始める」を押せる', await cdp.click('#btn-enter'));
    let went = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if ((await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) >= 0) { went = true; break; }
    }
    check('★押すとゲームへ進む', went);

    // ---- 2回目・3回目も同じであること ----
    //
    // 「初めての人だけ止める」で作った時は、ここで素通りしてしまい、
    // 予告編に辿り着けなくなっていた。何度開いても同じでなければならない。
    for (const n of [2, 3]) {
      await open(cdp);
      await sleep(4000);
      check(`★${n}回目も入口で止まる(素通りしない)`,
        (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0,
        await cdp.evaluate<string>(HERE));
      check(`${n}回目も予告編のボタンが出ている`,
        await cdp.evaluate<boolean>(
          'document.getElementById("btn-pv").getBoundingClientRect().width > 0'));
    }
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
