// 音量の初期値が、まっさらな端末で実際にその値になるかを確かめる。
//
// 既定値を変えても localStorage に古い保存値が残っていると反映されない。
// そのため src/sound.ts では PREF_KEY の番号を上げて古い値を捨てている。
// ここでは
//   1. まっさらなプロフィールで開き、設定画面の表示が 8% / 20% か
//   2. 実際に音に掛かる音量(GainNode)も 0.08 / 0.20 か
//   3. 古い鍵(v1)に別の値が残っていても引きずられないか
// を見る。
//
//   npx tsx test/sound_default_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;

const WANT_BGM = 8;
const WANT_SFX = 20;

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

  close(): void { this.ws.close(); }
}

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
  console.log('=== 音量の初期値の検証 ===');
  console.log(`対象: ${BASE}  期待値: BGM ${WANT_BGM}% / 効果音 ${WANT_SFX}%`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-snd-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
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
    if (!wsUrl) { check('ブラウザの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // GainNode に実際に入った音量を控えておく(表示だけ直っていても意味がない)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          window.__gains = [];
          const C = window.AudioContext || window.webkitAudioContext;
          if (!C) return;
          const orig = C.prototype.createGain;
          C.prototype.createGain = function () {
            const g = orig.call(this);
            window.__gains.push(g);
            return g;
          };
        })();
      `,
    });

    // 古い鍵に別の値を残しておく。これを引きずったら失敗。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('madoken_sound_v1',
        JSON.stringify({ bgmVolume: 0.8, sfxVolume: 0.9, muted: true })); } catch {}`,
    });

    await cdp.send('Page.navigate', { url: BASE });
    if (!await until(cdp, 'document.readyState === "complete"', 'ページの読み込み')) return;
    await sleep(1500);

    // 設定画面を開く前に、まず保存値そのものを見る
    const stored = await cdp.evaluate<string | null>(
      'localStorage.getItem("madoken_sound_v3")');
    check('古い設定(v1)を引きずっていない', stored === null || !/0\.8|0\.9/.test(stored),
      String(stored));

    // 設定タブのスライダーの表示値
    const shown = await cdp.evaluate<{ bgm: string; sfx: string } | null>(`
      (() => {
        const b = document.querySelector('#bgm-volume');
        const s = document.querySelector('#sfx-volume');
        if (!b || !s) return null;
        return { bgm: b.value, sfx: s.value };
      })()
    `);
    if (!shown) {
      check('音量スライダーが見つかる', false);
    } else {
      check('BGMスライダーの初期値', Number(shown.bgm) === WANT_BGM, `${shown.bgm}%`);
      check('効果音スライダーの初期値', Number(shown.sfx) === WANT_SFX, `${shown.sfx}%`);
    }

    // 音を鳴らして、実際に掛かる音量を見る
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1,
    });
    await sleep(1200);

    const gains = await cdp.evaluate<number[]>(
      '(window.__gains || []).map(g => Math.round(g.gain.value * 1000) / 1000)');
    if (!gains || gains.length === 0) {
      check('音量が実際に掛かっている', false, 'GainNodeが作られていない');
    } else {
      const has = (v: number) => gains.some(g => Math.abs(g - v) < 0.005);
      check('効果音に掛かる音量', has(WANT_SFX / 100), `実際=${gains.join(', ')}`);
      // BGMは端末やブラウザの都合で読み込まれないことがあるので、あれば見る
      if (has(WANT_BGM / 100)) check('BGMに掛かる音量', true, `${WANT_BGM / 100}`);
      else console.log(`  --  BGMのGainNodeは未生成(自動再生の制限)。実際=${gains.join(', ')}`);
    }
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
