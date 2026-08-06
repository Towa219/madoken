// ボスのステージに来たら曲が変わるかを確かめる。
//
// 曲は共闘部屋に入る時に一度だけ選んでいたため、勝ち上がって
// ボスのステージ(5の倍数)に来ても通常戦闘の曲のままだった。
//
// 実機のブラウザでステージ4から始め、倒してステージ5(ボス)へ進んだときに
// 読み込まれる音源が boss に変わるかを、通信の中身で見る。
//
//   npx tsx test/boss_bgm_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9381;

const NAME = `bg${Math.random().toString(36).slice(2, 6)}`;
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
  readonly bgm: string[] = [];

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
      // どの曲を読みに行ったかを通信から拾う
      if (m.method === 'Network.requestWillBeSent') {
        const u = String(m.params?.request?.url ?? '');
        // ファイル名にはハイフンも入る(5-10_Battle01.mp3 など)
        const hit = /\/sound\/bgm\/([\w.-]+?)\.mp3/.exec(u);
        if (hit && this.bgm[this.bgm.length - 1] !== hit[1]) this.bgm.push(hit[1]);
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

  close(): void { this.ws.close(); }
}

// ステージ4の敵をすぐ倒せる装備
function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: TOKEN, charId: 0, researchP: 500,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 },
      discoveries: [], level: 9, rarity: 'legend', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: 5, bestStage: 4,
    bossCleared: [], sortMode: 'use', codexRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== ボス戦で曲が変わるか ===');
  console.log(`対象: ${HTTP}  名前: ${NAME}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bgm-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900', 'about:blank',
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
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v2',
          JSON.stringify({ bgmVolume: 0.02, sfxVolume: 0, muted: false }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    // 音を鳴らせるようにするため、実際に押す
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 600, y: 400, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 600, y: 400, button: 'left', clickCount: 1 });
    await sleep(1500);

    await cdp.click('#tab-online');
    await sleep(2500);
    // ステージ4(通常)で部屋を作る
    const sel = await cdp.evaluate<boolean>(`
      (() => {
        const s = document.querySelector('#coop-stage');
        if (!s) return false;
        s.value = '4';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return s.value === '4';
      })()
    `);
    check('ステージ4を選べた', sel);
    check('部屋を作れた', await cdp.click('#btn-create-room'));
    await sleep(2500);
    check('準備完了を押せた', await cdp.click('#btn-coop-ready'));
    await sleep(6000);

    console.log(`     ここまでに読んだ曲: ${cdp.bgm.join(' → ')}`);
    check('通常ステージでは戦闘の曲', cdp.bgm.includes('battle'), cdp.bgm.join(' → '));
    const beforeBoss = cdp.bgm.length;

    // ステージ4を倒してステージ5(ボス)へ
    console.log('     (ステージ4を倒してボスへ…)');
    const end = Date.now() + 150_000;
    let reached = false;
    while (Date.now() < end) {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type, text: type === 'keyDown' ? '1' : undefined,
          key: '1', code: 'Digit1', windowsVirtualKeyCode: 49,
        });
      }
      await sleep(600);
      const t = await cdp.evaluate<string>('document.body.innerText');
      if (/ステージ\s*5/.test(t)) { reached = true; break; }
    }
    check('ステージ5(ボス)へ進んだ', reached);
    await sleep(4000);

    console.log(`     読んだ曲: ${cdp.bgm.join(' → ')}`);
    check('★ボスのステージで曲が変わった',
      cdp.bgm.slice(beforeBoss).some(b => b.startsWith('5-10_')),
      cdp.bgm.join(' → '));
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
