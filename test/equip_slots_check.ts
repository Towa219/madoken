// 装備できる魔法の数がボス撃破で増えるかを確かめる。
//
//   最初は4つ → ステージ10のボス撃破で5つ → ステージ20のボス撃破で6つ
//
// 数の判定は shared/data.ts の equipLimit ひとつに寄せてある。
// ここが崩れると、研究室では5つ装備できるのに戦闘のボタンは4つ、
// のように画面ごとに食い違う。実際のブラウザで
//   ・魔導書の見出しの「装備は◯つまで」
//   ・実際に装備できた数
//   ・戦闘画面の魔法ボタンの数
// が全部一致するかを見る。
//
//   npx tsx test/equip_slots_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EQUIP_BASE, EQUIP_MAX, EQUIP5_BOSS_STAGE, EQUIP6_BOSS_STAGE,
  equipLimit, nextEquipUnlock,
} from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9367;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- 1. 数の決まり方 ----
console.log('=== 装備できる数 ===');
check(`ボス未撃破は${EQUIP_BASE}つ`, equipLimit([]) === EQUIP_BASE, `${equipLimit([])}つ`);
check(`ステージ${EQUIP5_BOSS_STAGE}のボスで${EQUIP_BASE + 1}つ`,
  equipLimit([EQUIP5_BOSS_STAGE]) === EQUIP_BASE + 1);
check(`ステージ${EQUIP6_BOSS_STAGE}のボスで${EQUIP_BASE + 2}つ`,
  equipLimit([EQUIP5_BOSS_STAGE, EQUIP6_BOSS_STAGE]) === EQUIP_BASE + 2);
// 順番が前後しても、飛ばして倒しても正しく数える
check('20だけ倒した場合も最大になる',
  equipLimit([EQUIP6_BOSS_STAGE]) === EQUIP_BASE + 2,
  `${equipLimit([EQUIP6_BOSS_STAGE])}つ`);
check('関係ないステージでは増えない', equipLimit([3, 7, 99]) === EQUIP_BASE);
check('上限は解放後の最大と一致', EQUIP_MAX === EQUIP_BASE + 2, `${EQUIP_MAX}`);
check('次の解放が案内できる',
  nextEquipUnlock([])?.boss === EQUIP5_BOSS_STAGE
  && nextEquipUnlock([EQUIP5_BOSS_STAGE])?.boss === EQUIP6_BOSS_STAGE
  && nextEquipUnlock([EQUIP5_BOSS_STAGE, EQUIP6_BOSS_STAGE]) === null);

// ---- 2. 実際の画面 ----

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
    await sleep(350);
    return true;
  }

  close(): void { this.ws.close(); }
}

// 装備候補を多めに持たせたセーブ
function seedSave(name: string, bossCleared: number[]) {
  const sp = (i: number, recipe: Record<string, number>) =>
    ({ id: `s${i}`, name: `試験魔法${i}`, recipe, discoveries: [], level: 0, rarity: 'normal', stats: {} });
  return {
    version: 1, nickname: name, nickToken: `tok_${name}`, charId: 0,
    researchP: 500,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [
      sp(1, { fire: 3 }), sp(2, { water: 3 }), sp(3, { wind: 3 }), sp(4, { earth: 3 }),
      sp(5, { thunder: 3 }), sp(6, { ice: 3 }), sp(7, { light: 3 }), sp(8, { dark: 3 }),
    ],
    equipped: [],
    discovered: [], slots: 3, maxStage: 21, bestStage: 20,
    bossCleared, sortByPower: false, codexRewarded: false,
  };
}

async function browserCase(
  cdp: Cdp, label: string, bossCleared: number[], want: number,
): Promise<void> {
  console.log(`\n--- ${label} (期待: ${want}つ) ---`);
  const name = `eq${Math.random().toString(36).slice(2, 6)}`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('magic_web_game_save_v1',
        ${JSON.stringify(JSON.stringify(seedSave('__N__', bossCleared)))}.replace(/__N__/g, ${JSON.stringify(name)}));
      localStorage.setItem('madoken_sound_v4',
        JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
    } catch {}`,
  });
  await cdp.send('Page.navigate', { url: HTTP });
  for (let i = 0; i < 60; i++) {
    if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
    await sleep(250);
  }
  await sleep(2500);
  await cdp.click('#tab-lab');
  await sleep(600);

  // 見出しの案内
  const cap = await cdp.evaluate<string>(
    'document.querySelector("#equip-cap")?.textContent ?? ""');
  check('見出しの「装備は◯つまで」', cap.includes(String(want)), cap);

  // 8本あるうち、押せるだけ装備してみる(各カードの1つ目のボタンが「装備する」)
  for (let i = 0; i < 8; i++) {
    await cdp.evaluate(
      '(() => { const cards = document.querySelectorAll("#spell-list .spell-card");'
      + ` const b = cards[${i}] && cards[${i}].querySelector(".sbtns button");`
      + ' if (b && !b.disabled) b.click(); })()');
    await sleep(150);
  }
  const equipped = await cdp.evaluate<number>(
    '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").equipped || []).length');
  check('実際に装備できた数', equipped === want, `${equipped}つ`);

  // 戦闘画面の魔法ボタン
  await cdp.click('#tab-battle');
  await sleep(600);
  await cdp.click('#stage-select button:not(.boss)');
  await sleep(4500); // カウントダウン
  const btns = await cdp.evaluate<number>(
    'document.querySelectorAll("#spell-bar .spell-btn").length');
  check('戦闘の魔法ボタンの数', btns === want, `${btns}個`);

  // 撤退して片付ける
  await cdp.click('#btn-escape');
  await sleep(1200);
  try {
    await fetch(`${HTTP}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: `tok_${name}` }),
    });
  } catch { /* 消せなくても成否には関係ない */ }
}

async function main(): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'madoken-eq-'));
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

    await browserCase(cdp, 'ボス未撃破', [], EQUIP_BASE);
    await browserCase(cdp, `ステージ${EQUIP5_BOSS_STAGE}のボス撃破`,
      [EQUIP5_BOSS_STAGE], EQUIP_BASE + 1);
    await browserCase(cdp, `ステージ${EQUIP6_BOSS_STAGE}のボス撃破`,
      [EQUIP5_BOSS_STAGE, EQUIP6_BOSS_STAGE], EQUIP_BASE + 2);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
