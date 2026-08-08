// お供AIを実際にソロ戦闘へ連れて行って、画面の中で動くかを見る。
//
// test/ally_check.ts は判断だけを直接呼んで確かめている。
// こちらは配線を見る ― 選択欄から選べるか、戦闘に出てくるか、
// 詠唱バーが出るか、実際に敵を削るか、研究Pが×0.8になるか。
// 判断は通るのに戦闘に繋ぎ忘れている、という壊れ方はここでしか捕まらない。
//
//   npx tsx test/ally_battle_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLY_ENABLED, ALLY_RP_MUL } from '../shared/allies';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9441;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');

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
      // 画面側の例外を拾う。お供の処理で落ちると戦闘ごと止まる。
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
    await sleep(300);
    return true;
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

const NAME = `al${Math.random().toString(36).slice(2, 6)}`;

// 連れて行くお供。役どころごとに見たい時に替える。
//   MADOKEN_ALLY=紫紺 npx tsx test/ally_battle_check.ts
const PICK = process.env.MADOKEN_ALLY ?? '翠緑';
const PICK_ID: Record<string, number> = {
  黒金: 0, 白銀: 1, 紅蓮: 2, 翠緑: 3, 紫紺: 4, 蒼氷: 5,
};

// 研究Pは持たせておく(解放には要らないが、画面の表示に使う)。装備も1本。
function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0,
    researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '水流弾', recipe: { water: 2, wind: 1 },
      discoveries: [], level: 0, rarity: 'normal', equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: 3, bestStage: 2,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    allyUnlocked: false, allyCharId: null,   // 古いセーブのつもりで false から
  };
}

const SAVE = 'JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}")';

async function main(): Promise<void> {
  console.log('=== お供AIを戦闘に連れて行く ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-al-'));
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          try {
            localStorage.setItem('magic_web_game_save_v1',
              ${JSON.stringify(JSON.stringify(seedSave()))});
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

    // ---- 出撃準備を開く ----
    await cdp.click('#tab-battle');
    await sleep(800);

    // 旗が false の時は、何も出ないことだけを確かめて終わる。
    // 「出さない」ことこそが旗の値打ちなので、ここを飛ばしてはいけない。
    if (!ALLY_ENABLED) {
      check('★旗が false なのでお供の欄は出ない',
        await cdp.evaluate<boolean>(
          'document.getElementById("ally-box").classList.contains("hidden")'));
      check('選択画面も出ない',
        !await cdp.evaluate<boolean>(
          '!!document.querySelector("#ally-picker .ally-card")'));
      check('出撃準備は今までどおり押せる',
        await cdp.evaluate<boolean>(
          'document.getElementById("btn-solo-go").disabled === false'));
      await cdp.shot('ally_off');
      console.log('     (旗を true にすると、この先の項目も走る)');
      console.log(failures === 0
        ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
      cdp.close(); chrome.kill(); await sleep(400);
      process.exit(failures === 0 ? 0 : 1);
    }

    check('★お供の欄が出ている',
      await cdp.evaluate<boolean>(
        '!document.getElementById("ally-box").classList.contains("hidden")'));

    // ---- 解放は無い ----
    //
    // v0.101.0 で「お供を仲間にする」をやめた。研究Pを払う手順ごと
    // 消えているので、ボタンが残っていないこと・研究P0でもいきなり
    // 選べることを見る(ここが戻ると、また入口で待たされる)。
    await cdp.evaluate(`
      (() => {
        const k='magic_web_game_save_v1';
        const s=JSON.parse(localStorage.getItem(k)||'{}');
        s.researchP=0; s.allyUnlocked=false; localStorage.setItem(k, JSON.stringify(s));
      })()
    `);
    await cdp.evaluate('location.reload()');
    await sleep(4000);
    await cdp.click('#tab-battle');
    await sleep(800);
    check('★「お供を仲間にする」ボタンは無い',
      !await cdp.evaluate<boolean>('!!document.getElementById("btn-ally-unlock")'));
    check('★研究P0でも、いきなり選択画面が出ている',
      (await cdp.evaluate<number>(
        'document.querySelectorAll("#ally-picker .ally-card").length')) === 6,
      `${await cdp.evaluate<number>('document.querySelectorAll("#ally-picker .ally-card").length')}枚`);
    // 選ぶだけでは研究Pが動かないこと。
    // (0固定では見られない ― 日々のボーナスやクラウドの記録で
    //  読み込み時に増えることがあるため、前後の差で見る)
    const rpBefore = await cdp.evaluate<number>(`${SAVE}.researchP`);
    check('解放という文言も出ていない',
      !(await cdp.evaluate<string>('document.getElementById("ally-box").innerText'))
        .includes('仲間にする'));

    const cards = await cdp.evaluate<number>(
      'document.querySelectorAll("#ally-picker .ally-card").length');
    // 「連れて行かない」+ 自分以外の5人 = 6枚
    check('★選べるのは6枚(連れて行かない+自分以外の5人)', cards === 6, `${cards}枚`);
    check('自分(黒金)は選べない',
      !(await cdp.evaluate<string>('document.getElementById("ally-picker").innerText'))
        .includes('黒金'));
    check('最初は連れて行かない',
      await cdp.evaluate<boolean>(`${SAVE}.allyCharId === null`));
    await cdp.shot(`ally_picker`);

    // ---- お供を選ぶ ----
    const picked = await cdp.evaluate<boolean>(`
      (() => {
        const cs = [...document.querySelectorAll('#ally-picker .ally-card')];
        const t = cs.find(c => c.innerText.indexOf(${JSON.stringify(PICK)}) >= 0);
        if (!t) return false;
        t.click();
        return true;
      })()
    `);
    check(`${PICK}を選べる`, picked);
    await sleep(500);
    check('★選んだお供がセーブに残る',
      (await cdp.evaluate<number | null>(`${SAVE}.allyCharId`)) === PICK_ID[PICK],
      String(await cdp.evaluate<number | null>(`${SAVE}.allyCharId`)));
    check('★選んでも研究Pは減らない(解放費用は無い)',
      (await cdp.evaluate<number>(`${SAVE}.researchP`)) === rpBefore,
      `${rpBefore} → ${await cdp.evaluate<number>(`${SAVE}.researchP`)}`);

    // ---- 出撃 ----
    check('ソロで出撃できる', await cdp.click('#btn-solo-go'));
    await sleep(6000);   // カウントダウン3.6秒 + 少し戦う

    check('★戦闘中に落ちていない', cdp.errors.length === 0,
      cdp.errors.slice(0, 2).join(' / '));
    check('戦闘画面が出ている',
      await cdp.evaluate<boolean>(
        '!document.getElementById("battle-view").classList.contains("hidden")'));

    // お供が動いた証。10秒ほど見て、詠唱バーが1度でも出れば動いている。
    let sawCast = false;
    for (let i = 0; i < 60 && !sawCast; i++) {
      await sleep(250);
      sawCast = await cdp.evaluate<boolean>(`
        (() => {
          const b = window.__allyDebug;
          return !!(b && b.casted > 0);
        })()
      `);
    }
    check('★お供が魔法を撃った', sawCast,
      String(await cdp.evaluate<unknown>('JSON.stringify(window.__allyDebug ?? null)')));
    await cdp.shot(`ally_battle_${PICK}`);

    // ---- 決着まで見る ----
    // 決着まで最長200秒待つ。この検証はプレイヤーが一切撃たないので、
    // お供に手加減を入れた v0.98.0 からは決着に2分かかることがある
    // (120秒で切っていた時に、勝負がついていないのに落ちた)。
    let ended = false;
    for (let i = 0; i < 400; i++) {
      await sleep(500);
      ended = await cdp.evaluate<boolean>(
        '!document.getElementById("battle-overlay").classList.contains("hidden")');
      if (ended) break;
    }
    check('決着がつく', ended);
    if (ended) {
      const txt = await cdp.evaluate<string>(
        'document.getElementById("battle-overlay").innerText');
      check(`★研究Pに×${ALLY_RP_MUL}の断りが出る`,
        txt.indexOf('お供と一緒') >= 0 || txt.indexOf('研究Pは得られない') >= 0,
        txt.replace(/\n/g, ' / ').slice(0, 110));
      await cdp.shot(`ally_result_${PICK}`);
    }
    check('★最後まで落ちていない', cdp.errors.length === 0,
      cdp.errors.slice(0, 2).join(' / '));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
