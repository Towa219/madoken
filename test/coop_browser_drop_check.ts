// 実機のブラウザで通信が切れたとき、共闘に戻れるかを確かめる。
//
// coop_reconnect_check は Node版クライアントで共闘の接続だけを切っていた。
// 実際の回線断ではロビーの接続も同時に切れる。ロビー側には別の再接続処理が
// あるので、両方が同時に切れたときに互いを邪魔していないかは、
// ブラウザで通しでやってみないと分からない。
//
// 見るのは
//   ・切れたあとも共闘の画面に留まっているか(勝手にロビーへ戻されないか)
//   ・復帰を試みている案内が出るか
//   ・実際に戦闘へ戻れるか(戻ったあとも敵と戦えるか)
//
//   npx tsx test/coop_browser_drop_check.ts

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9373;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');

const NAME = `bd${Math.random().toString(36).slice(2, 6)}`;
const TOKEN = `tok_${NAME}`;

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
  readonly logs: string[] = [];

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
      // ページ側の console を拾う(復帰に失敗した理由を知るため)
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params?.args ?? [])
          .map((a: any) => String(a?.value ?? a?.description ?? '')).join(' ');
        if (txt) this.logs.push(txt);
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

  async click(sel: string): Promise<boolean> {
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
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(400);
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

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: TOKEN, charId: 0, researchP: 200,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '弱い魔弾', recipe: { water: 2 },
      discoveries: [], level: 0, rarity: 'normal', stats: {},
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: 1, bestStage: 0,
    bossCleared: [], sortByPower: false, codexRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== ブラウザで通信が切れたときの共闘の復帰 ===');
  console.log(`対象: ${HTTP}  名前: ${NAME}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bd-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
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
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // 開いた通信を全部つかまえておく。回線が落ちるとロビーも共闘も同時に切れるので、
    // それを再現するにはまとめて閉じる必要がある。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          window.__socks = [];
          const Orig = window.WebSocket;
          window.WebSocket = function (...args) {
            const ws = new Orig(...args);
            window.__socks.push(ws);
            return ws;
          };
          window.WebSocket.prototype = Orig.prototype;
          Object.assign(window.WebSocket, Orig);
          window.__killAll = () => {
            let n = 0;
            for (const ws of window.__socks) {
              try { if (ws.readyState === 1) { ws.close(4999); n++; } } catch {}
            }
            return n;
          };
          try {
            localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
            localStorage.setItem('madoken_sound_v4',
              JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
          } catch {}
        })();
      `,
    });

    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    await cdp.click('#tab-online');
    await sleep(2500);
    check('部屋を作れた', await cdp.click('#btn-create-room'));
    await sleep(2500);
    check('準備完了を押せた', await cdp.click('#btn-coop-ready'));
    await sleep(1600);
    await cdp.shot('coop_countdown');

    const inCoop = () => cdp.evaluate<boolean>(
      'document.querySelector("#coop-view")?.classList.contains("hidden") === false');
    const started = await (async () => {
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>(
          'document.querySelector("#coop-waiting")?.classList.contains("hidden") === true')) return true;
        await sleep(500);
      }
      return false;
    })();
    check('共闘の戦闘が始まった', started);
    check('共闘の画面にいる', await inCoop());

    const hpOf = () => cdp.evaluate<string>(
      'document.querySelector("#coop-enemy-status .ecard-hp")?.textContent ?? ""');
    const cast = async (times: number) => {
      for (let i = 0; i < times; i++) {
        for (const type of ['keyDown', 'keyUp']) {
          await cdp.send('Input.dispatchKeyEvent', {
            type, text: type === 'keyDown' ? '1' : undefined,
            key: '1', code: 'Digit1', windowsVirtualKeyCode: 49,
          });
        }
        await sleep(800);
      }
    };

    // まず切れる前に攻撃が通ることを確かめる。これが基準になる。
    const hp0 = await hpOf();
    await cast(8);
    const hp1 = await hpOf();
    check('切れる前は攻撃が通る', hp0 !== hp1 && hp1 !== '', `${hp0} → ${hp1}`);

    // ---- ここで回線が落ちたことにする ----
    const killed = await cdp.evaluate<number>('window.__killAll()');
    console.log(`     通信を${killed}本まとめて切断した(ロビー+共闘)`);
    check('切断できた', killed >= 1, `${killed}本`);

    // 切れた直後に共闘の画面から追い出されていないか
    await sleep(2000);
    check('切れた直後も共闘の画面に留まっている', await inCoop());
    const toastOf = () => cdp.evaluate<string>(
      'document.querySelector("#toast")?.textContent ?? ""');
    const toast1 = await toastOf();
    check('復帰を試みている案内が出た', toast1.includes('復帰を試みて'), toast1);
    await cdp.shot('coop_drop_1');

    // 復帰したかどうかは、消えてしまうトーストではなく
    // 「実際に戦えるか」で判定する。表示だけ戻っても遊べなければ意味がない。
    const before = await hpOf();

    // 案内は数秒で消えるので細かく見る。1秒間隔だと取りこぼす。
    let back = false;
    let failed = false;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const t = await toastOf();
      if (t.includes('共闘に復帰した')) { back = true; break; }
      if (t.includes('復帰できなかった')) { failed = true; break; }
    }
    if (cdp.logs.some(l => l.includes('復帰に失敗'))) {
      console.log('     復帰に失敗した理由:');
      for (const f of [...new Set(cdp.logs.filter(l => l.includes('復帰に失敗')))]) {
        console.log(`       ${f}`);
      }
    }
    check('★共闘に復帰できた', back, failed ? '復帰できなかったと表示された' : '');
    check('復帰後も共闘の画面にいる', await inCoop());
    await cdp.shot('coop_drop_2');

    // 戻ったあと、実際に戦えるか(魔法が撃てて敵のHPが動くか)
    await cast(14);
    const after = await hpOf();
    check('★復帰後に敵と戦える(HPが動く)', before !== after && after !== '',
      `${before} → ${after}`);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: TOKEN }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
