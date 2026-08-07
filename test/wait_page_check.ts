// 入口の待機ページ(GitHub Pages)を確かめる。
//
// このページの値打ちは「本体が眠っていても、すぐ出て・安心させて・
// 起きたら自動で進む」の3つ。眠っている状態は、本体への通信を
// 塞いで作る(実際に15分待つわけにはいかない)。
//
// 見るのは
//   ① 開いた直後に文言が読めるか(本体に一切触らずとも)
//   ② 魔法陣の絵が届くか
//   ③ 本体が眠っている間、待機ページに留まって経過を出し続けるか
//   ④ しばらく待つと「待たずに開く」の逃げ道が出るか
//   ⑤ 本体が起きていれば、そのまま自動でゲームへ進むか
//   ⑥ 外部(この待機ページの配信元と本体以外)を一切読みに行っていないか
//   ⑦ 予告編は押すまで読み込まれないか(21MBを最初から取りに行かせない)
//   ⑧ 予告編を見ている間、勝手にゲームへ飛ばされないか
//
//   npx tsx test/wait_page_check.ts

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WAIT_URL = process.env.MADOKEN_WAIT_URL ?? 'https://towa219.github.io/madoken/';
const GAME_HOST = 'madoken.onrender.com';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9421;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');

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
  readonly requested: string[] = [];

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const fn = this.waiting.get(m.id);
        if (fn) { this.waiting.delete(m.id); fn(m); }
        return;
      }
      // どこを読みに行ったかを全部控える(外部依存の見張りに使う)
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params?.request?.url;
        if (typeof u === 'string') this.requested.push(u);
      }
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

  // 実際の指と同じく画面の座標を押す。
  // 見えていないボタンは押せずに false を返す。
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

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`     画面: tools/shots/${name}.png`);
  }

  close(): void { this.ws.close(); }
}

const TEXT = 'document.getElementById("box").innerText';
const HERE = 'location.href';

async function main(): Promise<void> {
  console.log('=== 入口の待機ページ ===');
  console.log(`対象: ${WAIT_URL}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-wp-'));
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
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 520, height: 900, deviceScaleFactor: 2, mobile: true });

    // ---- 眠っている状態を作る(本体への通信を全部塞ぐ) ----
    await cdp.send('Network.setBlockedURLs', { urls: [`*${GAME_HOST}*`] });

    await cdp.send('Page.navigate', { url: WAIT_URL });
    // about:blank は最初から complete なので、行き先も一緒に見る
    for (let i = 0; i < 60; i++) {
      const done = await cdp.evaluate<boolean>(
        'document.readyState === "complete" && location.href.indexOf("about:blank") < 0');
      if (done) break;
      await sleep(200);
    }

    // ① すぐ読めるか
    const first = await cdp.evaluate<string>(TEXT);
    check('★開いた直後に「眠っています」と伝わる',
      first.includes('眠っています') && first.includes('故障ではありません'));
    check('待ち時間の目安が出ている', first.includes('30〜60秒'));
    check('自動で始まると伝えている', first.includes('自動で始まります'));
    check('題名が出ている', first.includes('魔導研究記'));

    // ② 絵
    const art = await cdp.evaluate<number>(`
      (() => {
        const urls = ['circle.png','circle_inner.png'];
        return urls.filter(u => performance.getEntriesByType('resource')
          .some(e => e.name.indexOf(u) >= 0 && e.responseStatus !== 404)).length;
      })()
    `);
    check('魔法陣の絵が2枚とも届く', art === 2, `${art}枚`);
    await cdp.shot('wait_page');

    // ③ 眠っている間は留まる
    await sleep(6000);
    check('★本体が眠っている間は待機ページに留まる',
      (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0,
      await cdp.evaluate<string>(HERE));
    const t6 = await cdp.evaluate<string>('document.getElementById("elapsed").textContent');
    check('経過秒が進んでいる', /経過 [1-9]\d*秒/.test(t6), t6);

    // ④ 逃げ道(25秒)
    console.log('     …「待たずに開く」が出るまで待つ(26秒)');
    await sleep(21000);
    check('★しばらく待つと「待たずに開く」が出る',
      await cdp.evaluate<boolean>(
        '!document.getElementById("slow").classList.contains("hidden")'));
    check('その行き先はゲーム本体',
      (await cdp.evaluate<string>('document.getElementById("direct").href'))
        .indexOf(GAME_HOST) >= 0);
    check('待たされていても、まだ待機ページに居る',
      (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0);
    await cdp.shot('wait_page_slow');

    // ⑥ 外部を読みに行っていないか
    //
    // 許すのは「この待機ページ自身の配信元」と「ゲーム本体」だけ。
    // 配信元を決め打ちにすると、ローカルに立てて試した時に
    // 自分自身を外部と誤判定する(実際にやった)。
    const selfOrigin = new URL(WAIT_URL).origin;
    const outside = cdp.requested.filter(u =>
      !u.startsWith('data:') && !u.startsWith('about:')
      && u.indexOf(selfOrigin) !== 0 && u.indexOf(GAME_HOST) < 0);
    check('★外部の読み込みが一切ない(遅い先に足を引かれない)',
      outside.length === 0, outside.slice(0, 3).join(' / '));

    // ⑦ 予告編は押すまで取りに行かない
    //
    // サムネイルの絵(88KB)は最初から出してよい。読ませないのは動画(21MB)。
    const pvLoaded = () => cdp.requested.some(u => u.indexOf('pv.mp4') >= 0);
    check('★予告編の動画は押すまで読み込まれない(21MBを先に取りに行かない)', !pvLoaded());
    check('サムネイルの絵は先に出ている',
      cdp.requested.some(u => u.indexOf('pv_poster.jpg') >= 0));

    // ⑧ 押すと読み込まれ、見ている間はゲームへ飛ばされない
    if (await cdp.click('#pv-thumb')) {
      await sleep(2500);
      check('★サムネイルを押すと予告編が読み込まれる', pvLoaded());
      check('予告編が開く',
        await cdp.evaluate<boolean>(
          '!document.getElementById("pv-modal").classList.contains("hidden")'));

      // 見ている最中に本体を起こしても、画面を奪わないこと
      await cdp.send('Network.setBlockedURLs', { urls: [] });
      await sleep(9000);
      check('★見ている間は勝手にゲームへ飛ばされない',
        (await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) < 0,
        await cdp.evaluate<string>(HERE));
      check('準備ができたことは知らせる',
        (await cdp.evaluate<string>(
          'document.getElementById("pv-note").textContent ?? ""')).indexOf('準備') >= 0);

      // 閉じたら送る
      await cdp.click('#btn-pv-close');
      let went = false;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if ((await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) >= 0) { went = true; break; }
      }
      check('★閉じるとゲームへ進む', went);
      await sleep(3000);
      check('進んだ先がゲームになっている',
        await cdp.evaluate<boolean>('!!document.querySelector("#tab-lab")'));
      console.log(failures === 0
        ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
      await sleep(400);
      cdp.close(); chrome.kill();
      process.exit(failures === 0 ? 0 : 1);
    }
    check('予告編のボタンが押せる', false);

    // ⑤ 起きていれば自動で進む
    await cdp.send('Network.setBlockedURLs', { urls: [] });
    console.log('     …本体への通信を通して、自動で進むか見る');
    let moved = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if ((await cdp.evaluate<string>(HERE)).indexOf(GAME_HOST) >= 0) { moved = true; break; }
    }
    check('★本体が起きたら自動でゲームへ進む', moved,
      await cdp.evaluate<string>(HERE));
    if (moved) {
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      check('進んだ先がゲームになっている',
        await cdp.evaluate<boolean>('!!document.querySelector("#tab-lab")'));
      // 戻るを押した時に待機ページへ戻らないこと(replace にしてある)
      check('★戻っても待機ページに引き戻されない',
        await cdp.evaluate<boolean>('history.length <= 2'),
        `history.length=${await cdp.evaluate<number>('history.length')}`);
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
