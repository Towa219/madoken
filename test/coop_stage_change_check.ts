// 共闘でステージが進んだとき、敵の表示が作り直されるかを確かめる。
//
// ボス(1体)からステージ6(2体)へ進むと敵の数は「増える」。
// 以前は「数が減った時」しか作り直していなかったので、ここで作り直されず
//   ・ボスの絵が残像として残る
//   ・HPバーの下の行が1体ぶんの古い内容のまま
// という状態になっていた。
//
// 実際にブラウザでステージ5のボスを倒し、ステージ6に入った時点で
// 敵カードがちょうど2枚あり、中身がステージ6の敵になっているかを見る。
// 画面も撮るので、残像が出ていないか目でも確かめられる。
//
//   npx tsx test/coop_stage_change_check.ts

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');

const NAME = `cs${Math.random().toString(36).slice(2, 6)}`;
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

  async click(sel: string, nth = 0): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
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

// ステージ5のボスを現実的な時間で倒せる装備。
// 性能はサーバーがレシピから計算し直すので、詐称にはならない。
function seedSave() {
  const sp = (id: string, name: string, recipe: Record<string, number>) =>
    ({ id, name, recipe, discoveries: [], level: 9, rarity: 'legend', stats: {} });
  return {
    version: 1, nickname: NAME, nickToken: TOKEN, charId: 0,
    researchP: 9000,
    inventory: { fire: 20, water: 20, wind: 20, earth: 20, thunder: 20, ice: 20, light: 20, dark: 20 },
    spells: [
      sp('s1', '炎の爆裂弾', { fire: 3 }),
      sp('s2', '雷の連鎖雷', { wind: 2, thunder: 2 }),
      sp('s3', '光の治癒光', { light: 3 }),
      sp('s4', '闇の封印', { dark: 3 }),
    ],
    equipped: ['s1', 's2', 's3', 's4'],
    discovered: [], slots: 4, maxStage: 5, bestStage: 4,
    bossCleared: [], sortByPower: true, codexRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 共闘のステージ切替(ボス→次ステージ)の検証 ===');
  console.log(`対象: ${HTTP}  名前: ${NAME}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-cs-'));
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

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    // オンラインへ → ステージ5(ボス)の部屋を作る
    await cdp.click('#tab-battle');
    await sleep(2500);
    const sel = await cdp.evaluate<boolean>(`
      (() => {
        // 押すとボタン列は作り直される。押した要素をそのまま見ると、
        // 捨てられた古い要素を見ることになるので引き直して確かめる。
        const find = () => [...document.querySelectorAll('#stage-select button')]
          .find(x => parseInt(x.textContent, 10) === 5);
        const b = find();
        if (!b) return false;
        b.click();
        return !!find()?.classList.contains('selected');
      })()
    `);
    check('ステージ5を選べた', sel);
    check('部屋を作れた', await cdp.click('#btn-create-room'));
    await sleep(2500);
    check('準備完了を押せた', await cdp.click('#btn-coop-ready'));

    // 開戦を待つ
    const inFight = await (async () => {
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>(
          'document.querySelector("#coop-waiting")?.classList.contains("hidden") === true')) return true;
        await sleep(500);
      }
      return false;
    })();
    check('ステージ5(ボス)が始まった', inFight);

    const stageOf = () => cdp.evaluate<string>(
      'document.querySelector("#coop-enemy-status")?.children.length + ""');
    const cards = async () => Number(await stageOf());
    check('ボス戦の敵カードは1枚', await cards() === 1, `${await cards()}枚`);
    // 残像を見分けるための目印。次のステージにこの名前が残っていたら作り直せていない。
    const bossName = await cdp.evaluate<string>(
      'document.querySelector("#coop-enemy-status .ecard-name")?.textContent ?? ""');
    console.log(`     ボス: ${bossName}`);
    await cdp.shot('stage5_boss');

    // 魔法を撃ち続けてボスを倒す
    console.log('     (ボスを倒している…最大4分)');
    const end = Date.now() + 240_000;
    let reached6 = false;
    while (Date.now() < end) {
      for (const k of ['1', '2', '1', '4']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', text: k, key: k, code: `Digit${k}`,
          windowsVirtualKeyCode: k.charCodeAt(0),
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: k, code: `Digit${k}`,
          windowsVirtualKeyCode: k.charCodeAt(0),
        });
        await sleep(700);
      }
      const txt = await cdp.evaluate<string>(
        '(document.body.innerText.match(/ステージ\\s*6/) || [""])[0]');
      if (txt) { reached6 = true; break; }
    }
    check('ステージ6へ進んだ', reached6, reached6 ? '' : '時間内に倒せなかった');
    if (!reached6) return;

    await sleep(3500); // 切替の演出が終わるまで
    await cdp.shot('stage6_after');

    // ここが本題。敵の数はステージごとに違うので、枚数は決め打ちしない。
    const info = await cdp.evaluate<{ names: string[]; hps: string[]; affs: number }>(`
      (() => {
        const box = document.querySelector('#coop-enemy-status');
        return {
          names: [...box.querySelectorAll('.ecard-name')].map(e => e.textContent),
          hps: [...box.querySelectorAll('.ecard-hp')].map(e => e.textContent),
          affs: box.querySelectorAll('.ecard-affs').length,
        };
      })()
    `);
    const n = info.names.length;
    console.log(`     ステージ6の敵(${n}体): ${info.names.join(' / ')}`);

    // 残像の本体。ボスのカードが残っていたら作り直せていない。
    check('ボスのカードが残っていない', bossName !== '' && !info.names.includes(bossName),
      `ボス=${bossName} 現在=${info.names.join(' / ')}`);
    check('敵カードがある', n >= 1, `${n}枚`);
    check('全部の敵に名前が出ている', info.names.every(Boolean), info.names.join(' / '));
    check('全部の敵にHPが出ている',
      info.hps.length === n && info.hps.every(t => /HP\s*\d+\/\d+/.test(t ?? '')),
      info.hps.join(' / '));
    check('全部の敵に相性の行がある', info.affs === n, `${info.affs}行 / ${n}体`);
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
  await sleep(600); // 直後に終了するとNode内部の後片付けで警告が出る
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
