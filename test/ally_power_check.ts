// お供の強さを測る ―「プレイヤーが何もしない」戦闘を最後まで見る。
//
// お供が強すぎるかどうかは、感想ではなく1つの問いで決められる:
//   プレイヤーが一発も撃たずに、お供だけで勝ててしまうか?
// 勝ててしまうなら、それは遊びを肩代わりしている。
//
// 6人ぶんを順に出して、決着・所要時間・お供の残HP・撃った数を並べる。
//
//   npx tsx test/ally_power_check.ts          (サーバー起動済みであること)
//   MADOKEN_STAGE=4 npx tsx test/ally_power_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLY_ENABLED, ALLY_MAX_HP } from '../shared/allies';
import { releaseTestNames } from './testnames';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9443;
const STAGE = Number(process.env.MADOKEN_STAGE ?? 4);

const NAMES = ['黒金', '白銀', '紅蓮', '翠緑', '紫紺', '蒼氷'];

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

// お供は自分以外しか選べない。お供が0番の時だけプレイヤーを1番にする。
function seedSave(allyCharId: number) {
  const charId = allyCharId === 0 ? 1 : 0;
  return {
    version: 1, nickname: `pw${allyCharId}`, nickToken: `tok_pw${allyCharId}`, charId,
    researchP: 0,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '水流弾', recipe: { water: 2, wind: 1 },
      discoveries: [], level: 0, rarity: 'normal', equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: STAGE, bestStage: STAGE - 1,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    allyUnlocked: true, allyCharId,
  };
}

interface Run {
  name: string;
  win: boolean | null;   // null = 決着せず
  sec: number;
  hp: number;
  casted: number;
}

async function runOne(cdp: Cdp, allyCharId: number): Promise<Run> {
  const name = NAMES[allyCharId];
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(allyCharId)))});
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
  await sleep(2500);

  // 出撃。ここから先はプレイヤーは一切触らない ― これが測定の肝。
  await cdp.evaluate('document.getElementById("tab-battle").click()');
  await sleep(600);
  await cdp.evaluate('document.getElementById("btn-solo-go").click()');

  const t0 = Date.now();
  let win: boolean | null = null;
  for (let i = 0; i < 400; i++) {          // 最長200秒
    await sleep(500);
    const ended = await cdp.evaluate<boolean>(
      '!document.getElementById("battle-overlay").classList.contains("hidden")');
    if (!ended) continue;
    const txt = await cdp.evaluate<string>(
      'document.getElementById("battle-overlay").innerText');
    win = txt.indexOf('勝利') >= 0;
    break;
  }
  const dbg = await cdp.evaluate<{ casted: number; hp: number } | null>(
    'window.__allyDebug ? { casted: window.__allyDebug.casted, '
    + 'hp: window.__allyDebug.hp } : null');
  return {
    name, win,
    sec: Math.round((Date.now() - t0) / 100) / 10,
    hp: dbg?.hp ?? -1,
    casted: dbg?.casted ?? 0,
  };
}

async function main(): Promise<void> {
  console.log('=== お供の強さを測る(プレイヤーは何もしない) ===');
  console.log(`対象: ${HTTP} / ステージ${STAGE} / お供のHP上限 ${ALLY_MAX_HP}`);
  if (!ALLY_ENABLED) {
    console.log('旗が false なので測るものが無い。');
    process.exit(0);
  }

  const profile = mkdtempSync(join(tmpdir(), 'madoken-pw-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  const runs: Run[] = [];
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

    for (let id = 0; id < 6; id++) {
      const r = await runOne(cdp, id);
      runs.push(r);
      const res = r.win === null ? '決着せず' : (r.win ? '★お供だけで勝った' : '負けた');
      console.log(`  ${r.name}: ${res} / ${r.sec}秒 / お供HP ${r.hp} / ${r.casted}回 唱えた`);
    }
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    await releaseTestNames(HTTP, [0,1,2,3,4,5].map(i => ({ name: `pw${i}`, token: `tok_pw${i}` })));
    cdp.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  const wins = runs.filter(r => r.win === true);
  console.log(`\n  放置で勝った数: ${wins.length} / ${runs.length}`
    + (wins.length > 0 ? ` (${wins.map(r => r.name).join('・')})` : ''));

  // 判定を「0人」にはしていない ― 敵の顔ぶれは毎回くじ引きで、
  // ステージ4でもいちばん軽い引き(小物2体・合計120前後)を引けば、
  // お供が持ち込んだMPぶんの手数だけで片づいてしまうことがある。
  // そこまで潰すとお供は何をしても意味が無くなる。
  //
  // 実測の推移(同じ手順・ステージ4):
  //   手加減なし              6/6 が放置で勝った
  //   ×0.5・再使用1.6倍        3/6
  //   ×0.4・再使用2.0倍        3/6  ← 数字を削るだけでは止まらなかった
  //   MPが戻らない(上の値)   1/6  ← 1戦で出せる総量に天井ができた
  //
  // ここが2人以上に戻ったら、それは手加減がどこかで外れている。
  const LIMIT = 1;
  check(`★放置で勝てるのは${LIMIT}人まで(お供は肩代わりしない)`,
    wins.length <= LIMIT,
    wins.length > LIMIT ? `${wins.map(r => r.name).join('・')}が勝ってしまう` : '');
  check('落ちていない', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' / '));

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
