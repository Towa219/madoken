// PCとスマホのように、2台で同じデータを続きから遊べるかを確かめる。
//
// 同じニックネームを2台で使うと、片方で進めた記録がもう片方には自動で
// 入ってこない。サーバーは「古いセーブでの上書き」を拒むのでデータは
// 壊れないが、知らせが無いと拒まれ続けて先に進めなくなる。
//
// 接続時にサーバーの保存時刻を見て、こちらより新しければ帯で知らせ、
//   取り込む             … 別の端末の記録をこちらへ
//   この端末のまま続ける … こちらでサーバーを上書き
// のどちらかを本人に選んでもらう。黙って上書きも取り込みもしない。
//
//   npx tsx test/multi_device_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9389;

const NAME = `md${Math.random().toString(36).slice(2, 6)}`;
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

function save(rp: number) {
  return {
    version: 1, nickname: NAME, nickToken: TOKEN, charId: 0, researchP: rp,
    inventory: { fire: 5, water: 5, wind: 5, earth: 5, thunder: 5, ice: 5, light: 5, dark: 5 },
    spells: [], equipped: [],
    discovered: [], slots: 3, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'use', codexRewarded: false,
  };
}

// 1台ぶんのブラウザを開く。端末ごとにプロフィールを分ける。
async function openDevice(port: number, label: string) {
  const profile = mkdtempSync(join(tmpdir(), `madoken-${label}-`));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const cdp = new Cdp();
  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch { /* まだ起動していない */ }
  }
  await cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return { cdp, chrome, profile };
}

async function boot(cdp: Cdp, rp: number): Promise<void> {
  await cdp.send('Page.navigate', { url: HTTP });
  for (let i = 0; i < 60; i++) {
    if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
    await sleep(250);
  }
  await sleep(1200);
  await cdp.evaluate(
    'localStorage.setItem("magic_web_game_save_v1", '
    + JSON.stringify(JSON.stringify(save(rp))) + ');'
    + 'localStorage.setItem("madoken_sound_v3",'
    + ' JSON.stringify({bgmVolume:0,sfxVolume:0,muted:true}));');
  await cdp.send('Page.reload');
  for (let i = 0; i < 60; i++) {
    if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
    await sleep(250);
  }
  await sleep(3500);
}

const rpOf = (cdp: Cdp) => cdp.evaluate<number>(
  '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").researchP) || 0');
const bannerText = (cdp: Cdp) => cdp.evaluate<string>(
  '(() => { const b = document.querySelector("#sync-banner");'
  + ' return b && !b.classList.contains("hidden") ? b.textContent : ""; })()');

async function main(): Promise<void> {
  console.log('=== 2台で同じデータを続きから遊べるか ===');
  console.log(`対象: ${HTTP}  名前: ${NAME}`);

  const pc = await openDevice(PORT, 'pc');
  const sp = await openDevice(PORT + 1, 'sp');
  try {
    // ---- PCで遊んで、サーバーへ保存させる ----
    await boot(pc.cdp, 1000);
    check('PC: 帯は出ない(最初の端末)', (await bannerText(pc.cdp)) === '',
      await bannerText(pc.cdp));
    await sleep(2000);
    // 研究Pを増やして保存させる(採取で減るので直接書き換えて保存を促す)
    await pc.cdp.click('#tab-online');
    await sleep(2500);
    check('PC: 研究P1000で始まった', (await rpOf(pc.cdp)) === 1000, String(await rpOf(pc.cdp)));

    // サーバーに載ったことを確かめる
    let onServer = 0;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${HTTP}/api/load`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: TOKEN }),
      }).then(x => x.json() as Promise<{ ok: boolean; data?: any }>);
      if (r.ok) { onServer = r.data?.rp ?? r.data?.researchP ?? 0; break; }
      await sleep(500);
    }
    check('PC: サーバーに保存された', onServer === 1000, String(onServer));

    // ---- スマホ側を開く。まだ何も同期していないので帯が出るはず ----
    await boot(sp.cdp, 30);   // スマホ側は古い(研究P30)
    await sp.cdp.click('#tab-online');
    await sleep(3500);
    const t1 = await bannerText(sp.cdp);
    check('★スマホ: 別の端末に新しい記録があると知らせる',
      t1.includes('もっと新しい記録'), t1.slice(0, 60));
    check('知らせに「取り込む」がある', t1.includes('取り込む'));
    check('知らせに「この端末のまま続ける」がある', t1.includes('この端末のまま続ける'));
    check('この時点ではまだ上書きされていない', (await rpOf(sp.cdp)) === 30,
      String(await rpOf(sp.cdp)));

    // ---- 取り込む ----
    check('「取り込む」を押せた', await sp.cdp.click('#sync-banner .sync-take'));
    let got = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      got = await rpOf(sp.cdp);
      if (got === 1000) break;
    }
    check('★スマホ: PCの続きから遊べる状態になった', got === 1000, `研究P=${got}`);
    check('取り込んだら知らせは消える', (await bannerText(sp.cdp)) === '');

    // ---- 取り込んだ端末を開き直しても、もう知らせは出ない ----
    await sp.cdp.send('Page.reload');
    for (let i = 0; i < 60; i++) {
      if (await sp.cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3500);
    await sp.cdp.click('#tab-online');
    await sleep(3000);
    check('取り込み後は知らせが出ない', (await bannerText(sp.cdp)) === '',
      (await bannerText(sp.cdp)).slice(0, 40));
  } finally {
    for (const d of [pc, sp]) {
      d.cdp.close();
      d.chrome.kill();
      await sleep(200);
      try { rmSync(d.profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    }
    try {
      await fetch(`${HTTP}/api/save/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: TOKEN }),
      });
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: TOKEN }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
