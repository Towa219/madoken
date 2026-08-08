// お供の強さが、自分の魔導値合計に比例しているか。
//
// 計算そのものは test/ally_check.ts が直接呼んで確かめている。
// こちらは〈配線〉を見る ― セーブの魔法 → 魔導値合計 → 倍率 →
// 戦闘に出てきたお供の持ち物、まで本当に届いているか。
// 計算は合っているのに戦闘へ渡し忘れている、という壊れ方はここでしか捕まらない。
//
//   npx tsx test/ally_scale_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLY_ENABLED, ALLY_MUL_MAX, ALLY_MUL_MIN } from '../shared/allies';
import { EQUIP_BASE } from '../shared/data';
import { finalStats, magicTotal } from '../shared/spellcraft';
import type { ElementCounts, Rarity } from '../shared/types';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9451;

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
  readonly errors: string[] = [];

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
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails;
        this.errors.push(String(d?.exception?.description ?? d?.text ?? '例外'));
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

  close(): void { this.ws.close(); }
}

// 弱い持ち物(始めたばかり)と、強い持ち物(深く進んだ人)。
const WEAK: { recipe: ElementCounts; level: number; rarity: Rarity }[] = [
  { recipe: { water: 2, wind: 1 }, level: 0, rarity: 'normal' },
];
const STRONG: { recipe: ElementCounts; level: number; rarity: Rarity }[] = [
  { recipe: { fire: 3, earth: 1 }, level: 9, rarity: 'legend' },
  { recipe: { thunder: 2, wind: 1 }, level: 9, rarity: 'legend' },
  { recipe: { light: 3, water: 1 }, level: 9, rarity: 'legend' },
  { recipe: { earth: 2, ice: 1, light: 1 }, level: 9, rarity: 'legend' },
];

function seedSave(set: typeof WEAK, tag: string) {
  return {
    version: 1, nickname: `sc${tag}`, nickToken: `tok_sc${tag}`, charId: 0,
    researchP: 0,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: set.map((s, i) => ({
      id: `s${i}`, name: `魔法${i}`, recipe: s.recipe,
      discoveries: [], level: s.level, rarity: s.rarity, equipCount: 1,
    })),
    equipped: ['s0'],
    discovered: [], slots: 3, maxStage: 2, bestStage: 1,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    allyUnlocked: true, allyCharId: 2,     // 紅蓮(1本目=灼熱弾大)
  };
}

// 検証側でも同じ数え方をして、画面が出す値と突き合わせる
function expectTotal(set: typeof WEAK): number {
  return magicTotal(
    set.map(s => ({ stats: finalStats(s.recipe, s.level, s.rarity, 0) })),
    EQUIP_BASE,
  );
}

interface Dbg { powerMul: number; power0: number }

async function runOne(cdp: Cdp, set: typeof WEAK, tag: string): Promise<Dbg | null> {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(set, tag)))});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}
      })();
    `,
  });
  await cdp.send('Page.navigate', { url: HTTP });
  for (let i = 0; i < 80; i++) {
    const done = await cdp.evaluate<boolean>(
      'document.readyState === "complete" && location.href.indexOf("about:blank") < 0');
    if (done) break;
    await sleep(250);
  }
  await sleep(2200);

  // 出撃準備の「お供」欄に、今の倍率が出ているか
  await cdp.evaluate('document.getElementById("tab-battle").click()');
  await sleep(700);
  const noteText = await cdp.evaluate<string>(
    '(document.getElementById("ally-note") || {}).innerText || ""');
  const total = expectTotal(set);
  check(`[${tag}] 出撃準備に魔導値合計 ${total.toLocaleString()} が出ている`,
    noteText.replace(/,/g, '').indexOf(String(total)) >= 0,
    noteText.replace(/\n/g, ' / ').slice(0, 80));

  await cdp.evaluate('document.getElementById("btn-solo-go").click()');
  await sleep(5200);
  return cdp.evaluate<Dbg | null>('JSON.parse(JSON.stringify(window.__allyDebug || null))');
}

async function main(): Promise<void> {
  console.log('=== お供の強さが魔導値合計に比例するか ===');
  console.log(`対象: ${HTTP}`);
  if (!ALLY_ENABLED) { console.log('旗が false なので見るものが無い。'); process.exit(0); }
  console.log(`  弱い持ち物の魔導値合計: ${expectTotal(WEAK)}`);
  console.log(`  強い持ち物の魔導値合計: ${expectTotal(STRONG)}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-sc-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,900', 'about:blank',
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
      { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });

    const weak = await runOne(cdp, WEAK, '弱');
    const strong = await runOne(cdp, STRONG, '強');
    if (!weak || !strong) { check('お供が戦闘に出てくる', false); return; }

    check(`★始めたばかりなら下限×${ALLY_MUL_MIN}`, weak.powerMul === ALLY_MUL_MIN,
      `×${weak.powerMul}`);
    check(`★強い人なら上限×${ALLY_MUL_MAX}`, strong.powerMul === ALLY_MUL_MAX,
      `×${strong.powerMul}`);
    check('★お供の持ち物の威力が実際に変わっている',
      strong.power0 > weak.power0 * 3.5,
      `灼熱弾大の威力 ${weak.power0} → ${strong.power0}`);
    check('落ちていない', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' / '));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
