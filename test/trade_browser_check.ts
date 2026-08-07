// 実機のブラウザ2台で、交易所の個人取引を最後まで通してみる。
//
// trade_check は卓の決まりごと、trade_e2e はサーバーの配線を見る。
// どちらも通るのに画面が動かない、という壊れ方はここでしか捕まらない ―
// ボタンが繋がっていない、素材庫の数が更新されない、卓が閉じない、など。
//
// localStorage は同じ生い立ちのタブどうしで共有されるので、
// ブラウザを2つ別々の場所で起動する(1つのブラウザの2タブでは
// 二人とも同じニックネームになってしまう)。
//
//   npx tsx test/trade_browser_check.ts

import { RARE_VALUE } from '../shared/trade';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');

const RUN = Math.random().toString(36).slice(2, 6);
const NAME_A = `trA${RUN}`;
const NAME_B = `trB${RUN}`;

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

  // 実際の指と同じく、画面の座標を押す。
  // 見えていない・無効になっているボタンは押せずに false を返す。
  async click(sel: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e || e.disabled) return null;
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
    await sleep(250);
    return true;
  }

  async waitFor(expr: string, what: string, ms = 15_000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      if (await this.evaluate<boolean>(expr)) return true;
      if (Date.now() - start > ms) { check(`${what}(待ち)`, false, 'タイムアウト'); return false; }
      await sleep(200);
    }
  }

  // セーブの中の素材庫を読む
  async inventory(): Promise<Record<string, number>> {
    return this.evaluate<Record<string, number>>(
      '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").inventory) || {}');
  }

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`     画面: tools/shots/${name}.png`);
  }

  close(): void { this.ws.close(); }
}

function seedSave(name: string, inv: Record<string, number>) {
  return {
    version: 1, nickname: name, nickToken: `tok_${name}`, charId: 0, researchP: 100,
    inventory: {
      fire: 0, water: 0, wind: 0, earth: 0, thunder: 0, ice: 0, light: 0, dark: 0,
      ...inv,
    },
    spells: [], equipped: [], discovered: [], slots: 3,
    maxStage: 1, bestStage: 0, bossCleared: [], codexRewarded: false,
    // ガチャチケットは配らせない(交易所を開いた時に演出が挟まると邪魔になる)
    tickets: 0, lastBonusDate: new Date().toISOString().slice(0, 10),
  };
}

// ブラウザを1つ起こして、セーブを仕込んでからゲームを開く
async function launch(
  port: number, tag: string, name: string, inv: Record<string, number>,
): Promise<{ cdp: Cdp; kill: () => void }> {
  const profile = mkdtempSync(join(tmpdir(), `madoken-${tag}-`));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch { /* まだ起動していない */ }
  }
  if (!wsUrl) throw new Error(`${tag}: ブラウザが起動しない`);
  await cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(name, inv)))});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}
      })();
    `,
  });
  await cdp.send('Page.navigate', { url: HTTP });
  // about:blank は最初から complete なので、行き先も一緒に見る
  for (let i = 0; i < 80; i++) {
    const done = await cdp.evaluate<boolean>(
      'document.readyState === "complete" && location.href.indexOf("about:blank") < 0');
    if (done) break;
    await sleep(250);
  }
  await sleep(2500);
  return { cdp, kill: () => {
    chrome.kill();
    setTimeout(() => {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    }, 500);
  } };
}

async function releaseNames(): Promise<void> {
  for (const name of [NAME_A, NAME_B]) {
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token: `tok_${name}` }),
      });
    } catch { /* 解放できなくても結果には影響しない */ }
  }
}

async function main(): Promise<void> {
  console.log('=== 交易所の個人取引(ブラウザ2台) ===');
  console.log(`対象: ${HTTP}  ${NAME_A}(火${RARE_VALUE * 2}) ⇔ ${NAME_B}(光3)`);

  let a: { cdp: Cdp; kill: () => void } | null = null;
  let b: { cdp: Cdp; kill: () => void } | null = null;
  try {
    a = await launch(9411, 'trA', NAME_A, { fire: RARE_VALUE * 2 });
    b = await launch(9412, 'trB', NAME_B, { light: 3 });
    const A = a.cdp;
    const B = b.cdp;

    // 二人ともロビーに繋がるまで待つ
    const online = '!!document.querySelector("#online-members .member-chip")';
    if (!await A.waitFor(online, 'Aがロビーに繋がる')) return;
    if (!await B.waitFor(online, 'Bがロビーに繋がる')) return;
    check('二人ともロビーに繋がった', true);

    // 交易所へ
    await A.click('#tab-shop');
    await B.click('#tab-shop');
    check('交易所を開ける',
      await A.evaluate<boolean>('!document.querySelector("#shop-screen").classList.contains("hidden")'));

    // 相手が一覧に出る
    const seeB = `!!document.querySelector('#trade-partners [data-name="${NAME_B}"]')`;
    if (!await A.waitFor(seeB, 'Aの一覧にBが出る')) return;
    check('取引相手の一覧に相手が出る', true);

    // ---- 申し込む → 受ける ----
    check('相手を押して申し込める',
      await A.click(`#trade-partners [data-name="${NAME_B}"]`));
    const invited = '!document.querySelector("#trade-invite").classList.contains("hidden")';
    if (!await B.waitFor(invited, 'Bに誘いが出る')) return;
    check('誘われた側に確認が出る',
      (await B.evaluate<string>('document.querySelector("#trade-invite-title").textContent ?? ""'))
        .includes(NAME_A));
    await B.shot('trade_invite');

    check('「受ける」を押せる', await B.click('#btn-trade-yes'));
    const atTable = '!document.querySelector("#trade-table").classList.contains("hidden")';
    if (!await A.waitFor(atTable, 'Aの卓が開く')) return;
    if (!await B.waitFor(atTable, 'Bの卓が開く')) return;
    check('二人とも卓に着いた', true);

    // ---- 火(光1ぶん) ⇔ 光1 ----
    for (let i = 0; i < RARE_VALUE; i++) {
      if (!await A.click('#trade-mine [data-elem="fire"] [data-act="plus"]')) {
        check(`火を${i + 1}個目まで置ける`, false);
        break;
      }
    }
    check('出した数が卓に出る',
      (await A.evaluate<string>(
        'document.querySelector(\'#trade-mine [data-elem="fire"] .trade-num\').textContent ?? ""'))
        === String(RARE_VALUE));
    check('手元に残る数が出る',
      (await A.evaluate<string>(
        'document.querySelector(\'#trade-mine [data-elem="fire"] .trade-rest\').textContent ?? ""'))
        === `残り${RARE_VALUE}`);
    check('置いただけでは素材庫は減らない',
      (await A.inventory()).fire === RARE_VALUE * 2);

    if (!await B.waitFor(
      '!!document.querySelector(\'#trade-theirs [data-elem="fire"]\')',
      'Bに相手の出し物が見える')) return;
    check('相手の出し物が見える', true);

    // まだ釣り合っていない
    check('釣り合う前は準備完了を押せない',
      await A.evaluate<boolean>('document.querySelector("#btn-trade-ready").disabled === true'));
    check('釣り合っていないと赤く出る',
      await A.evaluate<boolean>('document.querySelector("#trade-balance").className === "ng"'));

    check('Bが光を1個置ける',
      await B.click('#trade-mine [data-elem="light"] [data-act="plus"]'));
    if (!await A.waitFor('document.querySelector("#trade-balance").className === "ok"',
      '釣り合う')) return;
    check(`火${RARE_VALUE}と光1で釣り合う`, true);
    check('釣り合えば準備完了を押せる',
      await A.evaluate<boolean>('document.querySelector("#btn-trade-ready").disabled === false'));
    await A.shot('trade_table');

    // ---- 成立 ----
    check('Aが準備完了を押せる', await A.click('#btn-trade-ready'));
    if (!await B.waitFor(
      'document.querySelector("#trade-status").textContent.indexOf("準備完了") >= 0',
      'Bに相手の準備完了が伝わる')) return;
    check('相手の準備完了が伝わる', true);
    check('片方だけでは卓は閉じない',
      await A.evaluate<boolean>(
        '!document.querySelector("#trade-table").classList.contains("hidden")'));

    check('Bが準備完了を押せる', await B.click('#btn-trade-ready'));
    if (!await A.waitFor('document.querySelector("#trade-modal").classList.contains("hidden")',
      'Aの卓が閉じる')) return;
    if (!await B.waitFor('document.querySelector("#trade-modal").classList.contains("hidden")',
      'Bの卓が閉じる')) return;
    check('成立すると卓が閉じる', true);

    // ---- 持ち物 ----
    const invA = await A.inventory();
    const invB = await B.inventory();
    check(`Aは火が${RARE_VALUE}減って光が1増えた`,
      invA.fire === RARE_VALUE && invA.light === 1, `火${invA.fire} 光${invA.light}`);
    check(`Bは光が1減って火が${RARE_VALUE}増えた`,
      invB.light === 2 && invB.fire === RARE_VALUE, `火${invB.fire} 光${invB.light}`);
    check(`総数は変わらない(${RARE_VALUE * 2}+3 のまま)`,
      invA.fire + invA.light + invB.fire + invB.light === RARE_VALUE * 2 + 3);

    check('成立したことが画面に出る',
      (await A.evaluate<string>('document.querySelector("#trade-msg").textContent ?? ""'))
        .includes('成立'),
      await A.evaluate<string>('document.querySelector("#trade-msg").textContent ?? ""'));
    await A.shot('trade_done');

    // 素材庫の表示にも届いているか
    await A.click('#tab-lab');
    check('研究室の素材庫にも反映される',
      await A.evaluate<boolean>(
        'document.querySelector("#inv-grid").textContent.indexOf("光") >= 0'));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    a?.cdp.close();
    b?.cdp.close();
    a?.kill();
    b?.kill();
    await releaseNames();
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(600);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
