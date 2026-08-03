// ステージ50のボス討伐で、レジェンド魔法が初回だけ贈られるかを確かめる。
//
// レジェンドは通常の調合では1万分の1でしか出ない。最深部のボスを倒した証として
// 確実に1本渡す。2本目は出ない(何度倒しても増えない)。
//
// 実際にステージ50のボスを倒すには時間がかかるので、ここでは
// 報酬を渡す処理そのものをブラウザ上で呼んで確かめる。
// 「ボスを倒したら呼ばれるか」は coop.ts の stageclear で
// LEGEND_BOSS_STAGE と突き合わせている1行で、目視で追える範囲にしてある。
//
//   npx tsx test/legend_reward_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGEND_BOSS_STAGE, RARITIES } from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9393;

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

const NAME = `lg${Math.random().toString(36).slice(2, 6)}`;

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 500,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [], equipped: [],
    // 図鑑は未完成にしておく(図鑑報酬と取り違えないため)
    discovered: [], slots: 5, maxStage: 50, bestStage: 49,
    bossCleared: [], sortMode: 'use', codexRewarded: false, legendRewarded: false,
  };
}

// ページ側で報酬の処理を呼ぶ。ボスを倒した時に呼ばれるのと同じ入口。
const GRANT = '(window.__madokenGrantLegend && window.__madokenGrantLegend())';

async function main(): Promise<void> {
  console.log('=== ステージ50の討伐報酬(レジェンド) ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-lg-'));
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
        localStorage.setItem('madoken_sound_v2',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    const spells = () => cdp.evaluate<{ name: string; rarity: string }[]>(
      '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").spells || [])'
      + '.map(s => ({ name: s.name, rarity: s.rarity }))');
    const flag = () => cdp.evaluate<boolean>(
      '!!JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").legendRewarded');

    check('最初は魔法を持っていない', (await spells()).length === 0);
    check('最初は未受領', (await flag()) === false);

    // 図鑑を開いて、報酬の案内が出ているか
    await cdp.click('#tab-book');
    await sleep(800);
    const notice = await cdp.evaluate<string>('document.body.innerText');
    check(`図鑑にステージ${LEGEND_BOSS_STAGE}の報酬が案内されている`,
      notice.includes(`ステージ${LEGEND_BOSS_STAGE}`) && notice.includes(RARITIES.legend.name),
      notice.includes(`ステージ${LEGEND_BOSS_STAGE}`) ? '' : '案内が見当たらない');

    // 討伐の報酬を渡す
    const hasEntry = await cdp.evaluate<boolean>(
      "typeof window.__madokenGrantLegend === 'function'");
    check('報酬の処理を呼べる口がある', hasEntry);
    if (!hasEntry) return;
    await cdp.evaluate(GRANT);
    await sleep(600);

    const after1 = await spells();
    check('★レジェンド魔法が1つ増えた', after1.length === 1, `${after1.length}本`);
    check('品質がレジェンド', after1[0]?.rarity === 'legend', String(after1[0]?.rarity));
    check('カタカナの真名になっている', /[ァ-ヴー]/.test(after1[0]?.name ?? ''),
      after1[0]?.name ?? '');
    console.log(`     授かった魔法: ${after1[0]?.name}`);
    check('受領済みになった', (await flag()) === true);

    // ---- 2回目は増えない ----
    await cdp.evaluate(GRANT);
    await sleep(600);
    const after2 = await spells();
    check('★2回目は増えない(初回だけ)', after2.length === 1, `${after2.length}本`);

    // 何度呼んでも増えないこと(読み込み直しは、このテストでは
    // 起動時スクリプトが初期セーブを入れ直してしまうので確かめられない。
    // 受領済みの印はセーブに入っているので、次回起動時も渡らない)
    for (let i = 0; i < 3; i++) { await cdp.evaluate(GRANT); await sleep(200); }
    check('何度呼んでも増えない', (await spells()).length === 1);

    await cdp.click('#tab-lab');
    await sleep(400);
    await cdp.click('#tab-book');
    await sleep(800);
    const notice2 = await cdp.evaluate<string>('document.body.innerText');
    check('図鑑の案内が「討伐済み」に変わる', notice2.includes('討伐済み'),
      notice2.includes('討伐済み') ? '' : '変わっていない');
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
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
