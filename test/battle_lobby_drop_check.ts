// 戦闘中にロビーの接続だけが切れても、戦闘画面が消えないことを確かめる。
//
// ロビーと戦闘部屋は別々の接続。以前はロビーが切れると戦闘画面まで隠して
// ログイン画面に戻していたため、「戦闘中に勝手に部屋が落ちる」ように見えていた。
//
// 実際のブラウザで共闘部屋に入り、外から同じ名前でロビーに入り直して
// (= サーバーが古いロビー接続を閉じる)、戦闘画面が残るかを見る。
//
//   npx tsx test/battle_lobby_drop_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'colyseus.js';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const WS = BASE.replace(/^http/, 'ws');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;

const RUN = Math.random().toString(36).slice(2, 7);
const NAME = `tB${RUN}`;
const TOKEN = `tok${RUN}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const SAVE = {
  version: 1, nickname: NAME, nickToken: TOKEN, charId: 0, researchP: 100,
  inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 5, ice: 5, light: 5, dark: 5 },
  spells: [{
    id: 's1', name: '炎の魔弾', recipe: { fire: 2 },
    discoveries: [], level: 0, rarity: 'normal',
  }],
  equipped: ['s1'], discovered: [], slots: 4, maxStage: 3, bestStage: 2,
  bossCleared: [], sortByPower: false, codexRewarded: false,
};

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

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }

  close(): void { this.ws.close(); }
}

const visible = (sel: string) =>
  `(() => { const e = document.querySelector('${sel}');`
  + ' return !!e && !e.classList.contains(\'hidden\'); })()';

async function main(): Promise<void> {
  console.log('=== 戦闘中のロビー切断で戦闘画面が消えないかの検証 ===');
  console.log(`対象: ${BASE}  名前: ${NAME}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bl-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1100,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  let intruder: Awaited<ReturnType<Client['joinOrCreate']>> | null = null;

  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!wsUrl) { check('ヘッドレスChromeの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // セーブを入れてから読み込む(ニックネーム登録済み = 自動でオンラインに繋がる)
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(1500);
    await cdp.evaluate(
      `localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(SAVE))})`);
    await cdp.send('Page.navigate', { url: BASE });

    const online = await until(cdp, visible('#online-lobby'), 90000);
    check('ロビーに接続できた', online);
    if (!online) return;

    // 共闘部屋を作って戦闘画面へ
    await cdp.evaluate("document.querySelector('#tab-online').click()");
    await sleep(400);
    await cdp.evaluate("document.querySelector('#btn-create-room').click()");
    const inCoop = await until(cdp, visible('#coop-view'), 30000);
    check('共闘部屋に入れた', inCoop);
    if (!inCoop) return;

    // 外から同じ名前でロビーへ = サーバーが古いロビー接続を閉じる
    const client = new Client(WS);
    intruder = await client.joinOrCreate('lobby_chat', { name: NAME, nickToken: TOKEN });
    intruder.onMessage('*', () => { /* 受け取るだけ */ });
    await sleep(4000);

    check('ロビーが切れても共闘画面が残る',
      await cdp.evaluate<boolean>(visible('#coop-view')));
    check('ログイン画面に戻されない',
      !(await cdp.evaluate<boolean>(visible('#online-login'))));
    check('ロビー画面が戦闘の上に出てこない',
      !(await cdp.evaluate<boolean>(visible('#online-lobby'))));
  } finally {
    try { await intruder?.leave(); } catch { /* 無視 */ }
    cdp.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 無視 */ }
    await fetch(`${BASE}/api/name/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, token: TOKEN }),
    }).catch(() => undefined);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

async function until(cdp: Cdp, expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cdp.evaluate<boolean>(expr)) return true;
    await sleep(300);
  }
  return false;
}

void main();
