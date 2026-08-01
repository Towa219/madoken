// 初回起動画面の「データを引き継ぐ」が実際のブラウザで成立するかを確かめる。
//
// ヘッドレスChromeをCDPで操作し、
//   1. サーバーにセーブを作る
//   2. まっさらなブラウザで開く → ようこそ画面が出る
//   3. 「データを引き継ぐ」に切り替えてコードを貼り、引き継ぐ
//   4. 引き継いだ内容(研究P・魔法・最高ステージ)が入っているか確認
// までを通しで見る。
//
//   npx tsx test/welcome_transfer_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const NAME = `試験${Math.random().toString(36).slice(2, 6)}`;
const TOKEN = `tk${Math.random().toString(36).slice(2, 12)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- CDP の最小クライアント ----

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

  // ページ側でJSを実行して結果を受け取る
  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails));
    }
    return r.result?.result?.value as T;
  }

  close(): void { this.ws.close(); }
}

// 条件が満たされるまで待つ
async function until(
  cdp: Cdp, expr: string, label: string, timeoutMs = 20000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cdp.evaluate<boolean>(expr)) return true;
    await sleep(250);
  }
  console.log(`  (待機が時間切れ: ${label})`);
  return false;
}

async function main(): Promise<void> {
  console.log('=== 初回起動「データを引き継ぐ」の検証 ===');
  console.log(`対象: ${BASE}  名前: ${NAME}`);

  // 1. 引き継ぎ元のセーブを作る
  const seeded = {
    version: 1, nickname: NAME, researchP: 4321,
    inventory: { fire: 7 }, equipped: [],
    spells: [{
      id: 'sp1', name: '試験の魔法', recipe: { fire: 2 },
      discoveries: [], level: 0, rarity: 'normal',
    }],
    discovered: [], slots: 2, maxStage: 9, bestStage: 8,
    bossCleared: [], sortByPower: false, codexRewarded: false,
  };
  const saveRes = await fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: NAME, token: TOKEN, data: seeded, savedAt: Date.now(),
    }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);
  check('引き継ぎ元のセーブを作成', saveRes.ok, saveRes.error ?? '');
  if (!saveRes.ok) { finish(); return; }

  // 2. まっさらなプロフィールでブラウザを開く
  const profile = mkdtempSync(join(tmpdir(), 'madoken-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1000,800', 'about:blank',
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
    check('ヘッドレスChromeの起動', Boolean(wsUrl));
    if (!wsUrl) { finish(); return; }

    await cdp.connect(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: BASE });

    // 3. ようこそ画面が出るまで待つ
    const shown = await until(
      cdp,
      "!!document.querySelector('#welcome-overlay') && "
      + "!document.querySelector('#welcome-overlay').classList.contains('hidden')",
      'ようこそ画面の表示', 90000,
    );
    check('初回起動でようこそ画面が出る', shown);
    if (!shown) { finish(); return; }

    // 既定は「はじめて遊ぶ」
    check('既定は「はじめて遊ぶ」側',
      await cdp.evaluate<boolean>(
        "document.querySelector('#wt-new').classList.contains('active') && "
        + "!document.querySelector('#welcome-new').classList.contains('hidden')"));

    // 4. 「データを引き継ぐ」に切り替える
    await cdp.evaluate("document.querySelector('#wt-transfer').click()");
    await sleep(200);
    check('引き継ぎ側に切り替わる',
      await cdp.evaluate<boolean>(
        "!document.querySelector('#welcome-transfer').classList.contains('hidden') && "
        + "document.querySelector('#welcome-new').classList.contains('hidden')"));

    // 5. 先に「間違ったコード」を試す。黙って通ってしまわないことを確かめる。
    await cdp.evaluate(
      "document.querySelector('#welcome-code').value = 'そんな名前 / でたらめコード';"
      + "document.querySelector('#btn-welcome-transfer').click()");
    const errShown = await until(
      cdp,
      "(document.querySelector('#welcome-msg').textContent || '').length > 0 && "
      + "!document.querySelector('#welcome-msg').textContent.includes('引き継ぎ中')",
      '誤りの通知', 20000,
    );
    check('誤ったコードではエラーが出る', errShown,
      await cdp.evaluate<string>("document.querySelector('#welcome-msg').textContent"));
    check('誤ったコードでは画面が閉じない',
      !(await cdp.evaluate<boolean>(
        "document.querySelector('#welcome-overlay').classList.contains('hidden')")));
    check('やり直せる(ボタンが再び押せる)',
      !(await cdp.evaluate<boolean>(
        "document.querySelector('#btn-welcome-transfer').disabled")));

    // 6. 正しいコードを貼って引き継ぐ
    await cdp.evaluate(
      `document.querySelector('#welcome-code').value = ${JSON.stringify(`${NAME} / ${TOKEN}`)};`
      + "document.querySelector('#btn-welcome-transfer').click()");

    const done = await until(
      cdp,
      "document.querySelector('#welcome-overlay').classList.contains('hidden')",
      '引き継ぎ完了', 30000,
    );
    check('引き継ぎ後にようこそ画面が閉じる', done,
      done ? '' : await cdp.evaluate<string>(
        "document.querySelector('#welcome-msg').textContent"));

    // 7. 中身が入っているか
    const got = await cdp.evaluate<{ nickname: string; rp: number; spells: number; maxStage: number }>(
      "(() => { const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1') ?? '{}');"
      + ' return { nickname: s.nickname, rp: s.researchP,'
      + ' spells: (s.spells ?? []).length, maxStage: s.maxStage }; })()');
    check('ニックネームが引き継がれた', got?.nickname === NAME, `= ${got?.nickname}`);
    check('研究Pが引き継がれた', got?.rp === 4321, `= ${got?.rp}`);
    check('魔法が引き継がれた', got?.spells === 1, `= ${got?.spells}本`);
    check('最高ステージが引き継がれた', got?.maxStage === 9, `= ${got?.maxStage}`);
  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 無視 */ }
    // 使ったテスト名は解放してランキング等に残さない
    await fetch(`${BASE}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, token: TOKEN }),
    }).catch(() => undefined);
  }
  finish();
}

function finish(): void {
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
