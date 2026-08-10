// 「決闘に参加」を押した時、いまオンラインの全員に呼び出しが届くか。
//
// 見るのは3つ:
//   ① 別のタブ(研究室)を見ている人にも札が出る
//   ② 札を押すとそのまま決闘場へ入れる
//   ③ 戦っている最中の人には出さない(相手の一撃を見落とすため)
//
// ブラウザを2つ立ち上げて、片方が募集し、もう片方で確かめる。
//
//   npx tsx test/duel_call_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTestNames } from './testnames';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
  private chrome!: ReturnType<typeof spawn>;
  private profile = '';

  async launch(port: number, seed: object): Promise<boolean> {
    this.profile = mkdtempSync(join(tmpdir(), 'madoken-dc-'));
    this.chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--window-size=1100,900', 'about:blank',
    ], { stdio: 'ignore' });

    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) return false;

    this.ws = new WebSocket(wsUrl);
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
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride',
      { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          try {
            localStorage.setItem('magic_web_game_save_v1',
              ${JSON.stringify(JSON.stringify(seed))});
            localStorage.setItem('madoken_sound_v4',
              JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
          } catch {}
        })();
      `,
    });
    await this.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 80; i++) {
      const done = await this.evaluate<boolean>(
        'document.readyState === "complete" && location.href.indexOf("about:blank") < 0');
      if (done) break;
      await sleep(250);
    }
    return true;
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

  // 条件が満たされるまで待つ(決め打ちの待ち時間にしない)
  async until(expr: string, sec = 12): Promise<boolean> {
    for (let i = 0; i < sec * 4; i++) {
      if (await this.evaluate<boolean>(expr)) return true;
      await sleep(250);
    }
    return false;
  }

  close(): void {
    try { this.ws.close(); } catch { /* もう閉じている */ }
    try { this.chrome.kill(); } catch { /* もう死んでいる */ }
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
}

const A = `dc${Math.random().toString(36).slice(2, 6)}`;   // 募集する側
const B = `dc${Math.random().toString(36).slice(2, 6)}`;   // 受け取る側

// 決闘には装備した魔法が要る(無いと「先に調合して」で止まる)
function seedSave(name: string) {
  return {
    version: 1, nickname: name, nickToken: `tok_${name}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '水流弾', recipe: { water: 2, wind: 1 },
      discoveries: [], level: 0, rarity: 'normal', equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: 3, bestStage: 2,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    allyCharId: null,
  };
}

const CALL_SHOWN = '!document.getElementById("duel-call").classList.contains("hidden")';

async function main(): Promise<void> {
  console.log('=== 決闘の呼び出しが全員に届くか ===');
  console.log(`対象: ${HTTP}`);

  const a = new Cdp();
  const b = new Cdp();
  try {
    check('募集する側のブラウザが立つ', await a.launch(9463, seedSave(A)));
    check('受け取る側のブラウザが立つ', await b.launch(9465, seedSave(B)));

    // 両方ともオンラインに繋がるまで待つ(自動接続)
    const online = '!document.getElementById("online-lobby").classList.contains("hidden")';
    check('★二人ともオンラインに繋がる',
      await a.until(online, 20) && await b.until(online, 20));

    // 受け取る側は「研究室」を見ている ― 別のタブでも届くことが要点
    await b.evaluate('document.getElementById("tab-lab").click()');
    await sleep(500);
    check('受け取る側は研究室を見ている',
      await b.evaluate<boolean>(
        '!document.getElementById("lab-screen").classList.contains("hidden")'));
    check('まだ札は出ていない',
      !await b.evaluate<boolean>(CALL_SHOWN));

    // ---- ① 募集する ----
    await a.evaluate('document.getElementById("tab-battle").click()');
    await sleep(600);
    check('「決闘に参加」を押せる',
      await a.evaluate<boolean>(`
        (() => {
          const e = document.getElementById('btn-duel');
          if (!e || e.disabled) return false;
          e.click();
          return true;
        })()
      `));

    check('★別のタブを見ていても札が出る', await b.until(CALL_SHOWN, 15));
    const text = await b.evaluate<string>(
      'document.getElementById("duel-call").innerText');
    check('★誰が呼んでいるか分かる', text.includes(A), text.split('\n').join(' / '));

    // ---- ② 札から決闘場へ入れる ----
    await b.evaluate('document.getElementById("duel-call-go").click()');
    const inDuel = '!document.getElementById("duel-view").classList.contains("hidden")';
    check('★札を押すと決闘場に入れる', await b.until(inDuel, 15));
    check('押した札は消える', !await b.evaluate<boolean>(CALL_SHOWN));
    check('相手も決闘場にいる', await a.until(inDuel, 15));

    // ---- ③ 戦っている最中は出さない ----
    // いま二人とも決闘中。ここで新しい募集が流れても札は出ないはず。
    // (決闘中の画面から抜けずに確かめたいので、サーバーの知らせを直接起こす)
    const before = await b.evaluate<boolean>(CALL_SHOWN);
    check('決闘中は札が出ていない', !before);

    check('落ちていない', a.errors.length === 0 && b.errors.length === 0,
      [...a.errors, ...b.errors].slice(0, 2).join(' / '));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    a.close();
    b.close();
    await sleep(400);
    await releaseTestNames(HTTP, [A, B].map(n => ({ name: n, token: `tok_${n}` })));
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
