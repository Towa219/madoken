// 共闘で勝ち上がってボスのステージに着いた時、曲がボスの曲に変わるかを確かめる。
//
// 報告: 「まだレベル5のボス戦で古いBGMが流れている」
// ステージ5の部屋を直接作る道は boss_bgm_room_check.ts で通っている。
// 通っていないのは「ステージ4を倒して5へ勝ち上がる」道。
// 部屋に入った時にしか曲を決めていなければ、ここで通常戦闘の曲のままになる。
//
// 見るのは
//   ・ステージ4の戦闘中は通常戦闘の曲か
//   ・ステージ5に上がった時にボスの曲へ差し替わるか
//   ・その曲が実際に鳴っているか(読みに行っただけで止まっていないか)
//
//   npx tsx test/boss_bgm_progress_check.ts
//   MADOKEN_ENDPOINT=https://madoken.onrender.com npx tsx test/boss_bgm_progress_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9463;
const FROM = 4;   // ここから始めて
const TO = 5;     // ここ(ボス)まで勝ち上がる

const NAME = `bp${Math.random().toString(36).slice(2, 6)}`;

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
  readonly bgm: { t: number; name: string }[] = [];
  // 実際に応答が返ってきた曲(読みに行っただけと区別する)
  readonly res: { name: string; status: number }[] = [];
  private t0 = Date.now();

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
      if (m.method === 'Network.requestWillBeSent') {
        const u = String(m.params?.request?.url ?? '');
        const hit = /\/sound\/bgm\/([\w.-]+?)\.mp3/.exec(u);
        if (hit && this.bgm[this.bgm.length - 1]?.name !== hit[1]) {
          this.bgm.push({ t: (Date.now() - this.t0) / 1000, name: hit[1] });
        }
      }
      if (m.method === 'Network.responseReceived') {
        const u = String(m.params?.response?.url ?? '');
        const hit = /\/sound\/bgm\/([\w.-]+?)\.mp3/.exec(u);
        if (hit) this.res.push({ name: hit[1], status: Number(m.params?.response?.status) });
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
    await sleep(300);
    return true;
  }

  close(): void { this.ws.close(); }
}

// ステージ4を短時間で倒せるだけの魔法を持たせる(伝説・強化9の攻撃)。
// 勝てないと5へ上がれず、確かめたい所まで辿り着けない。
function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    // 安い攻撃魔法を4つ。1つを撃ち続けると再使用待ちとMP切れで手が止まり、
    // ステージ4を倒し切れずに確かめたい所へ辿り着けない。
    spells: [1, 2, 3, 4].map(n => ({
      id: `s${n}`, name: '', recipe: { fire: 2 }, discoveries: [],
      level: 9, rarity: 'legend', stats: {}, equipCount: 1,
    })),
    equipped: ['s1', 's2', 's3', 's4'],
    discovered: [], slots: 5, maxStage: 40, bestStage: 39,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 勝ち上がった先のボスの曲 ===');
  console.log(`対象: ${HTTP} / ステージ${FROM} → ${TO}(ボス)`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
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
    await cdp.send('Network.enable');

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0.05, sfxVolume: 0, muted: false }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    await cdp.click('#tab-battle');
    await sleep(2500);
    await cdp.evaluate(`
      (() => {
        const bs = [...document.querySelectorAll('#stage-select button')];
        const b = bs.find(x => parseInt(x.textContent, 10) === ${FROM});
        if (b) b.click();
      })()
    `);
    await sleep(600);
    check(`ステージ${FROM}の部屋を作れた`, await cdp.click('#btn-create-room'));
    await sleep(3000);
    check('準備完了を押せた', await cdp.click('#btn-coop-ready'));
    await sleep(8000);

    const beforeBoss = [...cdp.bgm];
    check(`ステージ${FROM}では通常戦闘の曲`,
      (beforeBoss[beforeBoss.length - 1]?.name ?? '') === 'battle',
      beforeBoss.map(b => b.name).join(' → ') || 'なし');

    // 倒すまで魔法を撃ち続ける。ステージが上がったら止める。
    let reached = 0;
    for (let i = 0; i < 220 && reached < TO; i++) {
      await cdp.evaluate(`
        (() => {
          for (const b of document.querySelectorAll('#coop-bar .spell-btn')) b.click();
        })()
      `);
      reached = await cdp.evaluate<number>(`
        (() => {
          const t = document.querySelector('#coop-view')?.innerText ?? '';
          const m = /ステージ\\s*(\\d+)/.exec(t);
          return m ? Number(m[1]) : 0;
        })()
      `);
      if (i % 30 === 29) console.log(`     …${i + 1}回撃った時点でステージ${reached}`);
      await sleep(900);
    }
    check(`ステージ${TO}へ勝ち上がれた`, reached >= TO, `今いるのはステージ${reached}`);
    if (reached < TO) return;

    // 上がった直後は開戦前の間があるので、少し見てから判断する
    await sleep(9000);

    const after = cdp.bgm.slice(beforeBoss.length);
    console.log(`     読みに行った順: ${cdp.bgm.map(b => `${b.t.toFixed(1)}秒:${b.name}`).join(' → ')}`);
    const last = cdp.bgm[cdp.bgm.length - 1]?.name ?? 'なし';
    check(`★ステージ${TO}でボスの曲に差し替わる`, last.startsWith('5-10_'),
      after.length === 0 ? '差し替えが一度も起きていない(通常戦闘の曲のまま)' : `今は ${last}`);

    // 読みに行っても届いていないことがある(その時は無音のまま戦うことになる)
    const got = cdp.res.filter(r => r.name.startsWith('5-10_'));
    check('ボスの曲が実際に届いている',
      got.some(r => r.status === 200 || r.status === 206),
      got.map(r => `${r.name}:${r.status}`).join(' / ') || '応答なし');
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
