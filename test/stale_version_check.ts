// 開きっぱなしの古い画面に「新しい版が出ている」と知らせるかを確かめる。
//
// 報告: 「まだレベル5のボス戦で古いBGMが流れている」「PCでずっと昔のBGMがなっている」
// 曲を差し替える道筋は本番でも正しく動いていた。原因は画面の側で、
// 古いページが起動時に読んだ古い音の一覧(boss → bgm/boss.mp3)を抱えたまま
// 何日も動き続けていたこと。読み込み直すまで直しは届かない。
//
// 見るのは
//   ・サーバーの版が自分と違う時に案内が出るか
//   ・その案内に読み込み直すボタンがあり、実際に読み込み直せるか
//   ・版が同じ時は何も出さないか(いつも出ていたら意味がない)
//
//   npx tsx test/stale_version_check.ts
//   MADOKEN_ENDPOINT=https://madoken.onrender.com npx tsx test/stale_version_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../shared/version';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9465;
const FAKE = '99.9.9'; // サーバーがこの版を名乗っているように見せる

const NAME = `sv${Math.random().toString(36).slice(2, 6)}`;

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

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 0,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// /api/status の返す版だけを差し替える。
// 「古い画面のまま、サーバーだけ新しくなった」状態をそのまま作れる。
function fakeVersionScript(version: string): string {
  return `try {
    localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
    localStorage.setItem('madoken_sound_v4',
      JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const u = String(typeof input === 'string' ? input : input?.url ?? '');
      const res = await real(input, init);
      if (!u.includes('/api/status')) return res;
      let body = {};
      try { body = await res.clone().json(); } catch {}
      body.version = ${JSON.stringify(version)};
      return new Response(JSON.stringify(body),
        { status: res.status, headers: { 'Content-Type': 'application/json' } });
    };
  } catch {}`;
}

const BANNER = `
  (() => {
    const el = document.querySelector('#update-banner');
    if (!el) return { exists: false, shown: false, text: '', btn: '' };
    return {
      exists: true,
      shown: !el.classList.contains('hidden'),
      text: el.textContent ?? '',
      btn: el.querySelector('button')?.textContent ?? '',
    };
  })()
`;

interface Banner { exists: boolean; shown: boolean; text: string; btn: string }

async function main(): Promise<void> {
  console.log('=== 古い画面への知らせ ===');
  console.log(`対象: ${HTTP} / この画面は v${VERSION}、サーバーは v${FAKE} と名乗る`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-sv-'));
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

    // ---- 1. 版がずれている ----
    let seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument',
      { source: fakeVersionScript(FAKE) });
    const open = async () => {
      await cdp.send('Page.navigate', { url: HTTP });
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(4000);
    };
    await open();

    let b = await cdp.evaluate<Banner>(BANNER);
    check('知らせの置き場所がある', b.exists);
    check('★版がずれていると知らせが出る', b.shown, b.text || '出ていない');
    check('新しい版の番号が書いてある', b.text.includes(FAKE), b.text);
    check('今の画面の版も書いてある', b.text.includes(VERSION), b.text);
    check('読み込み直すボタンがある', b.btn.includes('読み込み'), b.btn || 'ボタンなし');

    // ボタンで実際に読み込み直せるか(押しても何も起きなければ案内の意味がない)
    await cdp.evaluate('window.__stale = 1');
    await cdp.evaluate(`document.querySelector('#update-banner button').click()`);
    await sleep(4000);
    const gone = await cdp.evaluate<number | undefined>('window.__stale');
    check('★ボタンで実際に読み込み直せる', gone === undefined,
      gone === undefined ? '読み込み直された' : '画面がそのまま');

    // ---- 2. 版が同じ(いつも出ていたら案内にならない) ----
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
      { identifier: seeded.result?.identifier });
    seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument',
      { source: fakeVersionScript(VERSION) });
    await open();
    b = await cdp.evaluate<Banner>(BANNER);
    check('版が同じなら何も出さない', !b.shown, b.text || '出ていない');
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: `tok_${NAME}` }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
