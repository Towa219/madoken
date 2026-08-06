// 魔導書の「お気に入りの装備セット」を確かめる。
//
// 装備の並びはそのまま戦闘のキー1〜6になる。組み替えるたびに1本ずつ
// 着け直すのは手間で、しかも着けた順でキーが決まるので
// 「並びまで元どおり」にするのは自力では難しい。だからセットごと覚える。
//
// 見るのは
//   ・今の装備を覚えられるか
//   ・別の装備にしてから呼び出すと、並びまで元に戻るか
//   ・名前を付けられて、次に開いた時も残っているか
//   ・分解された魔法が入っていた時に黙って欠けないか(知らせが出るか)
//   ・装備できる数を超えるセットを呼んでも壊れないか
//
//   npx tsx test/loadout_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EQUIP_BASE, LOADOUT_COUNT } from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411;

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

const NAME = `lo${Math.random().toString(36).slice(2, 6)}`;

// 装備できる数(4)より多く持たせる。呼び出しで並びが変わるのを見たいため。
const SPELLS = [
  { id: 'a', recipe: { fire: 2 } },
  { id: 'b', recipe: { water: 2 } },
  { id: 'c', recipe: { wind: 2 } },
  { id: 'd', recipe: { earth: 2 } },
  { id: 'e', recipe: { ice: 2 } },
  { id: 'f', recipe: { light: 2 } },
];

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: SPELLS.map(s => ({
      id: s.id, name: '', recipe: s.recipe, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 0,
    })),
    equipped: ['a', 'b', 'c', 'd'],
    discovered: [], slots: 3, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// 画面のセット欄を操作する小道具(何番目のセットの何番目のボタンか)
const clickIn = (slot: number, sel: string) => `
  (() => {
    const card = document.querySelectorAll('#loadouts .loadout')[${slot}];
    if (!card) return false;
    const b = card.querySelector(${JSON.stringify(sel)});
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()
`;

const EQUIPPED = '(JSON.parse(localStorage.getItem("magic_web_game_save_v1")||"{}").equipped||[])';
const LOADOUTS = '(JSON.parse(localStorage.getItem("magic_web_game_save_v1")||"{}").loadouts||[])';

async function main(): Promise<void> {
  console.log('=== お気に入りの装備セット ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-lo-'));
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

    const seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v3',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(2500);

    // 初期セーブを入れる仕掛けはここで外す。
    // 残したままだと読み込み直すたびに初期状態へ戻され、
    // このあと仕込むセーブが毎回消える。
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: seeded.result?.identifier,
    });

    // セーブを書き換えて開き直し、魔導書を開くところまで
    const reopen = async (mutate: string) => {
      await cdp.evaluate(`
        (() => {
          const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1'));
          (${mutate})(s);
          localStorage.setItem('magic_web_game_save_v1', JSON.stringify(s));
        })()
      `);
      await cdp.send('Page.reload');
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      await cdp.evaluate('document.querySelector("#tab-lab").click()');
      await sleep(900);
    };

    await cdp.evaluate('document.querySelector("#tab-lab").click()');
    await sleep(900);

    const cards = await cdp.evaluate<number>(
      'document.querySelectorAll("#loadouts .loadout").length');
    check(`セット欄が${LOADOUT_COUNT}つ出ている`, cards === LOADOUT_COUNT, `${cards}つ`);

    // ---- 1. 今の装備を覚える ----
    check('「今の装備を保存」を押せた',
      await cdp.evaluate<boolean>(clickIn(0, '.lo-btns button:nth-child(2)')));
    await sleep(500);
    const saved = await cdp.evaluate<{ name: string; ids: string[] }[]>(LOADOUTS);
    check('★セットに今の装備が入った',
      JSON.stringify(saved[0]?.ids) === JSON.stringify(['a', 'b', 'c', 'd']),
      JSON.stringify(saved[0]?.ids));
    check('セーブに残っている(次に開いても消えない)', saved.length === LOADOUT_COUNT);

    // ---- 2. 装備を入れ替えてから呼び出す ----
    // 順番まで変える。並びが戻らないと戦闘のキーがずれる。
    await reopen(`s => {
      s.equipped = ['f', 'e', 'd'];
      s.loadouts[0] = { name: 'ボス用', ids: ['a', 'b', 'c', 'd'] };
    }`);

    const before = await cdp.evaluate<string[]>(EQUIPPED);
    check('入れ替え後の装備', JSON.stringify(before) === JSON.stringify(['f', 'e', 'd']),
      JSON.stringify(before));
    const nameShown = await cdp.evaluate<string>(
      'document.querySelectorAll("#loadouts .lo-name")[0]?.value ?? ""');
    check('★付けた名前が残っている', nameShown === 'ボス用', nameShown);

    check('「呼び出す」を押せた',
      await cdp.evaluate<boolean>(clickIn(0, '.lo-btns button:nth-child(1)')));
    await sleep(600);
    const after = await cdp.evaluate<string[]>(EQUIPPED);
    check('★並びまで元どおりに戻る',
      JSON.stringify(after) === JSON.stringify(['a', 'b', 'c', 'd']),
      JSON.stringify(after));

    const marks = await cdp.evaluate<string>(
      '[...document.querySelectorAll("#spell-list .eqnum")].map(e => e.textContent).join("")');
    check('魔導書の①②③④も付け直されている', marks.includes('①') && marks.includes('④'), marks);

    // ---- 3. 分解済み・入りきらない場合 ----
    // 存在しない魔法を混ぜ、さらに装備できる数(EQUIP_BASE)より多くする
    await reopen(`s => {
      s.loadouts[0] = { name: '壊れ', ids: ['a', 'zzz', 'b', 'c', 'd', 'e'] };
      s.equipped = [];
    }`);

    const gone = await cdp.evaluate<number>(
      'document.querySelectorAll("#loadouts .lo-gone").length');
    check('分解済みの枠が見た目で分かる', gone >= 1, `${gone}件`);

    check('壊れたセットも呼び出せる',
      await cdp.evaluate<boolean>(clickIn(0, '.lo-btns button:nth-child(1)')));
    await sleep(700);
    const fixed = await cdp.evaluate<string[]>(EQUIPPED);
    check('★分解済みは飛ばし、装備できる数までで収まる',
      fixed.length === EQUIP_BASE && !fixed.includes('zzz'),
      JSON.stringify(fixed));
    const toast = await cdp.evaluate<string>(
      'document.querySelector("#toast")?.textContent ?? ""');
    check('★欠けたことが知らされる',
      toast.includes('分解済み') && toast.includes('入らなかった'), toast);

    // ---- 4. iPhoneの幅ではみ出さないか ----
    // 調合台のスロットで同じことが起きたので、増やしたものは毎回ここで測る。
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(500);
    await cdp.evaluate('document.querySelector("#tab-lab").click()');
    await sleep(900);
    const fit = await cdp.evaluate<{
      over: number; widest: number; box: number; cards: number;
    }>(`
      (() => {
        const box = document.querySelector('#loadouts');
        const cards = [...box.querySelectorAll('.loadout')];
        const widest = cards.reduce((m, c) => Math.max(m, c.getBoundingClientRect().width), 0);
        return {
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          widest: Math.round(widest),
          box: Math.round(box.getBoundingClientRect().width),
          cards: cards.length,
        };
      })()
    `);
    // 幅が0なら画面に出ていない。測れていないのに合格にしない。
    check('スマホ幅でもセット欄が見えている',
      fit.cards === LOADOUT_COUNT && fit.box > 100, `${fit.cards}枠 / 親${fit.box}px`);
    check('★スマホ幅で横にはみ出さない', fit.over <= 0, `${fit.over}pxはみ出し`);
    check('セットの枠が親からはみ出していない', fit.widest > 0 && fit.widest <= fit.box,
      `枠${fit.widest}px / 親${fit.box}px`);
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
