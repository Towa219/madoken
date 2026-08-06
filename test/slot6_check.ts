// 調合台の第6スロットを確かめる。
//
// 解放条件は「ステージ35のボス撃破 + 研究P1000」。
// ボスは共闘でしか倒せないので、ここではセーブを仕込んで条件の成立/不成立を作る。
//
// 見るのは
//   ・条件を満たすまで押せないか(ボスだけ・研究Pだけでは開かない)
//   ・満たすと押せて、実際に6枠になるか
//   ・6枠になってもスマホ幅で横にはみ出さないか(5枠で一度はみ出している)
//   ・6枠が上限で、それ以上の案内が出ないか
//   ・素材6個のレシピが実際に調合できるか
//
//   npx tsx test/slot6_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SLOTS, SLOT6_BOSS_STAGE, SLOT6_COST } from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9461;

const NAME = `s6${Math.random().toString(36).slice(2, 6)}`;

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

// 第5スロットまで開けた状態のセーブ。研究Pとボス撃破は呼び出し側で差し替える。
function seedSave(rp: number, bossCleared: number[]) {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: rp,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [], equipped: [],
    discovered: [], slots: 5, maxStage: 40, bestStage: 39,
    bossCleared, sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

const UNLOCK_BTN = '#slot-unlock button';
const btnState = `
  (() => {
    const b = document.querySelector('${UNLOCK_BTN}');
    if (!b) return { exists: false, disabled: true, text: '', cond: '' };
    return {
      exists: true, disabled: b.disabled, text: b.textContent,
      cond: document.querySelector('#slot-unlock .note')?.textContent ?? '',
    };
  })()
`;
const SLOT_COUNT = 'document.querySelectorAll("#slot-row .slot").length';

interface Btn { exists: boolean; disabled: boolean; text: string; cond: string }

async function main(): Promise<void> {
  console.log('=== 調合台の第6スロット ===');
  console.log(`対象: ${HTTP} / 条件: ステージ${SLOT6_BOSS_STAGE}のボス + 研究P${SLOT6_COST}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-s6-'));
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

    // セーブを仕込んで開き直す
    let seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1',
          ${JSON.stringify(JSON.stringify(seedSave(SLOT6_COST, [10, 20])))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    const open = async () => {
      await cdp.send('Page.navigate', { url: HTTP });
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      await cdp.evaluate('document.querySelector("#tab-lab").click()');
      await sleep(700);
    };
    // 別の条件のセーブに差し替えて開き直す。
    // 起動時に流し込む仕掛けを毎回入れ替える(残すと古い方が上書きしてしまう)。
    const reseed = async (rp: number, boss: number[]) => {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
        { identifier: seeded.result?.identifier });
      const save = JSON.stringify(JSON.stringify(seedSave(rp, boss)));
      seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('magic_web_game_save_v1', ${save});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}`,
      });
      await open();
    };

    // ---- 1. ボス未撃破(研究Pは足りている) ----
    await open();
    check('最初は5枠', await cdp.evaluate<number>(SLOT_COUNT) === 5,
      String(await cdp.evaluate<number>(SLOT_COUNT)));
    let b = await cdp.evaluate<Btn>(btnState);
    check('第6スロットの案内が出ている', b.exists && b.text.includes('第6'), b.text);
    check('研究Pが足りていても、ボス未撃破なら押せない', b.disabled, b.text);
    check(`条件にステージ${SLOT6_BOSS_STAGE}のボスと書いてある`,
      b.cond.includes(String(SLOT6_BOSS_STAGE)), b.cond);

    // ---- 2. ボス撃破済みだが研究Pが足りない ----
    await reseed(SLOT6_COST - 1, [10, 20, SLOT6_BOSS_STAGE]);
    b = await cdp.evaluate<Btn>(btnState);
    check('ボスを倒しても研究Pが1足りなければ押せない', b.disabled,
      `研究P${SLOT6_COST - 1}`);
    check('条件クリアと表示される', b.cond.includes('条件クリア'), b.cond);

    // ---- 3. 両方満たす ----
    await reseed(SLOT6_COST, [10, 20, SLOT6_BOSS_STAGE]);
    b = await cdp.evaluate<Btn>(btnState);
    check('★両方満たすと押せる', !b.disabled, b.text);

    await cdp.evaluate(`document.querySelector('${UNLOCK_BTN}').click()`);
    await sleep(800);
    const after = await cdp.evaluate<number>(SLOT_COUNT);
    check('★押すと6枠になる', after === 6, `${after}枠`);
    const rpLeft = await cdp.evaluate<number>(
      'JSON.parse(localStorage.getItem("magic_web_game_save_v1")).researchP');
    check(`研究Pが${SLOT6_COST}減っている`, rpLeft === 0, `残り${rpLeft}`);

    const b2 = await cdp.evaluate<Btn>(btnState);
    check(`${MAX_SLOTS}枠が上限(それ以上の案内は出ない)`, !b2.exists, b2.text);

    // ---- 4. 6個置いて実際に調合できるか ----
    const filled = await cdp.evaluate<number>(`
      (() => {
        const cards = [...document.querySelectorAll('#inv-grid .elem-card')];
        for (let i = 0; i < 6; i++) cards[i % cards.length].click();
        return document.querySelectorAll('#slot-row .slot.filled').length;
      })()
    `);
    check('★6個の素材を置ける', filled === 6, `${filled}個`);
    const craftOk = await cdp.evaluate<boolean>(
      '!document.querySelector("#btn-craft")?.disabled');
    check('6個でも調合ボタンが押せる', craftOk);

    // ---- 5. スマホ幅ではみ出さないか ----
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(500);
    await cdp.evaluate('document.querySelector("#tab-lab").click()');
    await sleep(900);
    const fit = await cdp.evaluate<{ over: number; row: number; wide: number; n: number }>(`
      (() => {
        const row = document.querySelector('#slot-row');
        const slots = [...row.querySelectorAll('.slot')];
        const r = row.getBoundingClientRect();
        const right = slots.reduce((m, s) => Math.max(m, s.getBoundingClientRect().right), 0);
        return {
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          row: Math.round(r.right),
          wide: Math.round(right),
          n: slots.length,
        };
      })()
    `);
    check('スマホ幅でも6枠が出ている', fit.n === 6, `${fit.n}枠`);
    check('★スマホ幅で横にはみ出さない', fit.over <= 0, `${fit.over}pxはみ出し`);
    check('★枠が調合台の右端をはみ出さない', fit.wide <= fit.row + 1,
      `枠の右端${fit.wide}px / 台の右端${fit.row}px`);
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
