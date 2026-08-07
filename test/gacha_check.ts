// ショップのガチャを確かめる。
//
// 見るのは
//   ・確率表が 100% になっているか(表と実装がずれていないか)
//   ・チケットが無いと引けないか
//   ・引くとチケットが1枚減り、魔法が1本増えるか
//   ・演出が出て、飛ばせて、結果が出るか
//   ・出た品質と結果の表示が一致しているか
//   ・演出の途中で閉じてもチケットの二重消費や取りこぼしが起きないか
//
// 品質は運任せなので、引いた結果をそのまま突き合わせる方式にしてある。
// 特定の品質を狙って出したい時だけ Math.random を差し替える。
//
//   npx tsx test/gacha_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GACHA_ODDS, rollGachaRarity } from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9481;

const NAME = `gc${Math.random().toString(36).slice(2, 6)}`;

// ログインボーナスの「今日」と同じ形にする(src/daily.ts と同じ作り)
function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

function seedSave(tickets: number) {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    // 今日の分はもらった事にしておく。ログインボーナスで枚数が動くと
    // 「引いて1枚減った」のか「配られて1枚増えた」のか区別できない。
    // 日付そのものを入れること。'seeded' のような文字では今日と一致せず、
    // 開いた瞬間に1枚配られてしまう(実際にそれで数が合わなくなった)。
    bossRewarded: [], tickets, lastBonusDate: todayKey(),
  };
}

const snap = () => `
  (() => {
    const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1') || '{}');
    const fx = document.querySelector('#gacha-fx');
    const res = document.querySelector('#gacha-result');
    return {
      tickets: s.tickets, spells: (s.spells || []).length,
      last: (s.spells || []).slice(-1)[0] || null,
      fxOpen: !!fx && !fx.classList.contains('hidden'),
      resultOpen: !!res && !res.classList.contains('hidden'),
      rarityText: document.querySelector('#gacha-result-rarity')?.textContent ?? '',
      nameText: document.querySelector('#gacha-result-name')?.textContent ?? '',
      drawDisabled: !!document.querySelector('#gacha-draw')?.disabled,
      shown: document.querySelector('#ticket-display')?.textContent ?? '',
    };
  })()
`;

interface Snap {
  tickets: number; spells: number; last: { rarity: string; name: string } | null;
  fxOpen: boolean; resultOpen: boolean; rarityText: string; nameText: string;
  drawDisabled: boolean; shown: string;
}

const RARITY_JA: Record<string, string> = {
  normal: '通常', rare: 'レア', epic: 'エピック', legend: 'レジェンド',
};

async function main(): Promise<void> {
  console.log('=== ショップのガチャ ===');
  console.log(`対象: ${HTTP}`);

  // ---- 0. 確率表(ブラウザを立ち上げずに確かめられる分) ----
  const sum = GACHA_ODDS.reduce((a, o) => a + o.pct, 0);
  check('★確率の合計が100%', sum === 100, `${sum}%`);
  const edge = [
    [0, 'legend'], [0.0099, 'legend'], [0.011, 'epic'], [0.079, 'epic'],
    [0.081, 'rare'], [0.299, 'rare'], [0.301, 'normal'], [0.9999, 'normal'],
  ] as const;
  const bad = edge.filter(([r, want]) => rollGachaRarity(r) !== want);
  check('★確率の境目が表のとおり', bad.length === 0,
    bad.map(([r, w]) => `${r}→${w}のはず`).join(' / '));

  const profile = mkdtempSync(join(tmpdir(), 'madoken-gc-'));
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

    let seeded: any = null;
    const openWith = async (tickets: number) => {
      if (seeded) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
          { identifier: seeded.result?.identifier });
      }
      seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(tickets)))});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}`,
      });
      await cdp.send('Page.navigate', { url: HTTP });
      // about:blank も readyState は complete なので、行き先が変わるのも待つ
      for (let i = 0; i < 60; i++) {
        const here = await cdp.evaluate<string>('location.href');
        if (here && !here.startsWith('about:')
          && await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      await cdp.evaluate('document.querySelector("#tab-shop").click()');
      await sleep(600);
    };

    // ---- 1. ショップが開けて、確率表が出る ----
    await openWith(2);
    const opened = await cdp.evaluate<boolean>(
      '!document.querySelector("#shop-screen").classList.contains("hidden")');
    check('★ショップのタブが開く', opened);
    const odds = await cdp.evaluate<number>(
      'document.querySelectorAll("#gacha-odds .gacha-odd").length');
    check('確率表が出ている', odds === GACHA_ODDS.length, `${odds}件`);

    // ---- 2. 引くとチケットが減り、魔法が増える ----
    const before = await cdp.evaluate<Snap>(snap());
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(400);
    const during = await cdp.evaluate<Snap>(snap());
    check('★演出が出る', during.fxOpen);
    check('演出中は結果を見せない', !during.resultOpen);
    check('★引いた直後にチケットが減る', during.tickets === before.tickets - 1,
      `${before.tickets}→${during.tickets}枚`);

    // 演出を飛ばす(実際の操作と同じく、覆いを押す)
    for (let i = 0; i < 6; i++) {
      await cdp.evaluate('document.querySelector("#gacha-fx").click()');
      await sleep(120);
    }
    await sleep(900);
    const after = await cdp.evaluate<Snap>(snap());
    check('★演出を飛ばすと結果が出る', after.resultOpen);
    check('★魔法が1本増える', after.spells === before.spells + 1,
      `${before.spells}→${after.spells}本`);
    check('★出た品質と表示が一致する',
      !!after.last && after.rarityText === RARITY_JA[after.last.rarity],
      `保存=${after.last?.rarity} 表示=${after.rarityText}`);
    check('★出た魔法と表示が一致する',
      !!after.last && after.nameText === after.last.name,
      `保存=${after.last?.name} 表示=${after.nameText}`);
    check('上のバーの枚数も減っている', after.shown.includes(String(after.tickets)),
      after.shown);

    // ---- 3. 結果を閉じても取りこぼさない ----
    await cdp.evaluate('document.querySelector("#gacha-close").click()');
    await sleep(300);
    const closed = await cdp.evaluate<Snap>(snap());
    check('結果を閉じると演出も消える', !closed.fxOpen);
    check('閉じても魔法は残る', closed.spells === before.spells + 1,
      `${closed.spells}本`);

    // ---- 4. チケットが尽きたら引けない ----
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      await cdp.evaluate('document.querySelector("#gacha-fx").click()');
      await sleep(120);
    }
    await sleep(700);
    await cdp.evaluate('document.querySelector("#gacha-close").click()');
    await sleep(300);
    const empty = await cdp.evaluate<Snap>(snap());
    check('★2回引くとチケットが0になる', empty.tickets === 0, `${empty.tickets}枚`);
    check('★0枚では引くボタンが押せない', empty.drawDisabled);

    // 押しても増えないことまで見る(ボタンの見た目だけの無効化を防ぐ)
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(600);
    const stuck = await cdp.evaluate<Snap>(snap());
    check('★0枚で押しても魔法は増えない', stuck.spells === empty.spells,
      `${empty.spells}→${stuck.spells}本`);
    check('チケットが負にならない', stuck.tickets === 0, `${stuck.tickets}枚`);
  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
