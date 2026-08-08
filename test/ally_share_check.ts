// プレイヤーの「全体」魔法が、お供にも届くか。
//
// 届く6系統: 聖域盾(護盾) / 慈雨(回復) / 万象護符(耐性) /
//            鼓舞(最大HP) / 戦鼓(与ダメ) / 魔力共鳴(MP回復)
// 届かない  : 単体版(守護の護符・治癒光・護盾…)
//
// 「全体と名乗っているのに隣の子に届かない」という壊れ方は、
// 見た目には何も起きないので気づけない。ここでだけ捕まる。
//
// 確かめ方は、実際に戦闘へ出て魔法を撃ち、window.__allyDebug を読む。
// (Pixi の中身は外から覗けないので、戦闘側が毎フレーム書き出している)
//
//   npx tsx test/ally_share_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLY_ENABLED } from '../shared/allies';
import { releaseTestNames } from './testnames';
import { finalStats } from '../shared/spellcraft';
import type { ElementCounts } from '../shared/types';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9449;

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

// 試す魔法。全体版5つと、比較用の単体版1つ。
//
// 賦活/鼓舞(最大HP)は maxHp が伸びたかで見るので debug の maxHp を使う。
interface Trial {
  id: string;
  name: string;
  recipe: ElementCounts;
  all: boolean;              // 全体版か
  needHurt?: boolean;        // お供が傷つくまで待ってから撃つ(回復用)
  // お供に届いたかの判定(戦闘中の控えを見る)
  landed: (d: Dbg, before: Dbg) => boolean;
}

interface Dbg {
  hp: number; maxHp: number; shield: number; warded: boolean;
  atkBoost: number; mpRegenBonus: number; alive: boolean;
}

const TRIALS: Trial[] = [
  {
    id: 'seiiki', name: '聖域盾(全体護盾)', all: true,
    recipe: { earth: 2, ice: 1, light: 1 },
    landed: d => d.shield > 0,
  },
  {
    id: 'banshou', name: '万象護符(全体耐性)', all: true,
    recipe: { water: 2, ice: 1, wind: 1 },
    landed: d => d.warded,
  },
  {
    id: 'senko', name: '戦鼓(全体・与ダメ)', all: true,
    recipe: { fire: 2, thunder: 1, wind: 1 },
    landed: d => d.atkBoost > 0,
  },
  {
    id: 'kyoumei', name: '魔力共鳴(全体・MP回復)', all: true,
    recipe: { ice: 2, light: 1, wind: 1 },
    landed: d => d.mpRegenBonus > 0,
  },
  {
    id: 'koubu', name: '鼓舞(全体・最大HP)', all: true,
    recipe: { earth: 2, light: 1, wind: 1 },
    landed: (d, b) => d.maxHp > b.maxHp,
  },
  {
    id: 'jiu', name: '慈雨(全体回復)', all: true,
    recipe: { light: 3, water: 1 },
    // 満タンでは回復のしようがないので、この1件だけは
    // お供が殴られるのを待ってから撃つ(needHurt)。
    needHurt: true,
    landed: (d, b) => d.hp > b.hp,
  },
  {
    id: 'shugo', name: '護符(単体・比較用)', all: false,
    recipe: { water: 2, ice: 1 },
    landed: d => d.warded,        // ここが true になったら配りすぎ
  },
];

function seedSave(t: Trial) {
  return {
    version: 1, nickname: `sh${t.id}`, nickToken: `tok_sh${t.id}`, charId: 0,
    researchP: 0,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: t.name, recipe: t.recipe,
      discoveries: [], level: 0, rarity: 'normal', equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: 2, bestStage: 1,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    // お供は紫紺(土)。回復を持たないので、控えが動いたら
    // 「プレイヤーの魔法が届いた」とはっきり言える。
    allyUnlocked: true, allyCharId: 4,
  };
}

const DBG = 'JSON.parse(JSON.stringify(window.__allyDebug || null))';

async function runOne(cdp: Cdp, t: Trial): Promise<void> {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(t)))});
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

  await cdp.evaluate('document.getElementById("tab-battle").click()');
  await sleep(500);
  await cdp.evaluate('document.getElementById("btn-solo-go").click()');
  await sleep(5200);            // カウントダウン3.6秒 + 少し

  // 回復を測る回は、お供が殴られるまで待つ(満タンでは差が出ない)。
  if (t.needHurt) {
    let hurt = false;
    for (let i = 0; i < 100 && !hurt; i++) {          // 最長50秒
      await sleep(500);
      const d = await cdp.evaluate<Dbg | null>(DBG);
      hurt = !!d && d.alive && d.hp < d.maxHp - 5;
    }
    if (!hurt) {
      console.log(`  --  ${t.name}: お供が最後まで無傷で測れなかった`);
      return;
    }
  }

  const before = await cdp.evaluate<Dbg | null>(DBG);
  if (!before) { check(`${t.name}: お供が出てこない`, false); return; }

  // 魔法ボタンを押す。
  // ★ click ではなく pointerdown ― 戦闘の魔法ボタンは pointerdown で撃つ
  //   (ダブルタップ拡大よけで2回目の click が消えるため。src/nozoom.ts と対)。
  const pressed = await cdp.evaluate<boolean>(`
    (() => {
      const b = document.querySelector('#spell-bar .spell-btn');
      if (!b || b.disabled) return false;
      b.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      return true;
    })()
  `);
  if (!pressed) { check(`${t.name}: 魔法を撃てる`, false); return; }

  // 詠唱が終わるのを待つ
  const cast = finalStats(t.recipe, 0, 'normal', 0).castTime;
  await sleep(cast * 1000 + 1200);

  const after = await cdp.evaluate<Dbg | null>(DBG);
  if (!after) { check(`${t.name}: 控えが読めない`, false); return; }

  const landed = t.landed(after, before);
  const detail = `盾${after.shield} 耐性${after.warded ? '有' : '無'} `
    + `与ダメ+${after.atkBoost} MP回復+${after.mpRegenBonus} 上限${after.maxHp}`;
  if (t.all) {
    check(`★${t.name} がお供に届く`, landed, detail);
  } else {
    check(`★${t.name} はお供に届かない(単体版)`, !landed, detail);
  }
}

async function main(): Promise<void> {
  console.log('=== 全体魔法がお供に届くか ===');
  console.log(`対象: ${HTTP}`);
  if (!ALLY_ENABLED) { console.log('旗が false なので見るものが無い。'); process.exit(0); }

  const profile = mkdtempSync(join(tmpdir(), 'madoken-sh-'));
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

    // 組んだレシピが狙った系統になっているか、先に確かめておく。
    // ここがずれていると、届く・届かない以前の話になる。
    for (const t of TRIALS) {
      const st = finalStats(t.recipe, 0, 'normal', 0);
      check(`${t.name} は${t.all ? '全体' : '単体'}版になっている`,
        st.targetAll === t.all, `targetAll=${st.targetAll} kind=${st.kind}`);
    }

    for (const t of TRIALS) await runOne(cdp, t);

    check('落ちていない', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' / '));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    await releaseTestNames(HTTP, TRIALS.map(t => ({ name: `sh${t.id}`, token: `tok_sh${t.id}` })));
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
