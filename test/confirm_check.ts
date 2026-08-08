// 「取り返しのつかない操作」の手前で、必ず一度たずねるか。
//
// 見るのは2つ:
//   ① 調合 ―「調合する」の1回目では素材が減らず、ボタンが確認に変わる
//   ② 乗り換え ― 確認の窓が出て、「やめる」なら研究Pもキャラも動かない
//
// どちらも「押した瞬間に持ち物が減る」のを止めるための仕掛けなので、
// 見るべきは見た目ではなく〈1回目で減っていないこと〉。
//
//   npx tsx test/confirm_check.ts   (サーバー起動済みであること)

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAR_CHANGE_COST } from '../shared/characters';
import { releaseTestNames } from './testnames';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9447;
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

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`     画面: tools/shots/${name}.png`);
  }

  close(): void { this.ws.close(); }
}

const NAME = `cf${Math.random().toString(36).slice(2, 6)}`;

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0,
    researchP: 500,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [], equipped: [],
    discovered: [], slots: 3, maxStage: 3, bestStage: 2,
    bossCleared: [], codexRewarded: false, tickets: 0,
    lastBonusDate: new Date().toISOString().slice(0, 10),
    allyUnlocked: false, allyCharId: null,
  };
}

const SAVE = 'JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}")';

async function main(): Promise<void> {
  console.log('=== 確認をはさむか(調合・乗り換え) ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-cf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1200,950', 'about:blank',
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
      { width: 1200, height: 950, deviceScaleFactor: 1, mobile: false });
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

    // ================= ① 調合 =================
    console.log('\n-- 調合 --');
    // 火を2つ置く(素材庫の火を2回押す)
    const put = await cdp.evaluate<boolean>(`
      (() => {
        const cards = [...document.querySelectorAll('#inv-grid .elem-card')];
        const fire = cards.find(c => c.innerText.indexOf('火') >= 0);
        if (!fire) return false;
        fire.click(); fire.click();
        return true;
      })()
    `);
    check('素材を2つ置ける', put);
    await sleep(400);

    const fireBefore = await cdp.evaluate<number>(`${SAVE}.inventory.fire`);
    check('ボタンが「調合する」になっている',
      (await cdp.evaluate<string>('document.getElementById("btn-craft").textContent'))
        .indexOf('調合する') >= 0);

    // 1回目
    await cdp.evaluate('document.getElementById("btn-craft").click()');
    await sleep(400);
    const label1 = await cdp.evaluate<string>(
      'document.getElementById("btn-craft").textContent');
    check('★1回目でボタンが確認に変わる', label1.indexOf('本当に') >= 0, label1);
    check('確認中と分かる色が付く',
      await cdp.evaluate<boolean>(
        'document.getElementById("btn-craft").classList.contains("confirm")'));
    check('★1回目では素材が減らない',
      (await cdp.evaluate<number>(`${SAVE}.inventory.fire`)) === fireBefore,
      `火 ${fireBefore} → ${await cdp.evaluate<number>(`${SAVE}.inventory.fire`)}`);
    check('★1回目では魔法もできない',
      (await cdp.evaluate<number>(`(${SAVE}.spells || []).length`)) === 0);
    await cdp.shot('confirm_craft');

    // スロットを触ると確認は取り消される(別の組み合わせに変えたのに
    // 前の確認が生きていた、が起きないこと)
    await cdp.evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('#inv-grid .elem-card')];
        const water = cards.find(c => c.innerText.indexOf('水') >= 0);
        if (water) water.click();
      })()
    `);
    await sleep(400);
    check('★中身を変えると確認は取り消される',
      !(await cdp.evaluate<string>('document.getElementById("btn-craft").textContent'))
        .includes('本当に'));

    // もう一度1回目→2回目で、今度は実際に調合される
    await cdp.evaluate('document.getElementById("btn-craft").click()');
    await sleep(300);
    await cdp.evaluate('document.getElementById("btn-craft").click()');
    await sleep(4500);   // 進行バー(素材3つで約2秒)+余裕
    const fireAfter = await cdp.evaluate<number>(`${SAVE}.inventory.fire`);
    const spells = await cdp.evaluate<number>(`(${SAVE}.spells || []).length`);
    check('★2回目で本当に調合される', fireAfter < fireBefore || spells > 0,
      `火 ${fireBefore} → ${fireAfter} / 魔法 ${spells}本`);

    // ================= ② 乗り換え =================
    console.log('\n-- キャラの乗り換え --');
    await cdp.evaluate('document.getElementById("tab-settings").click()');
    await sleep(700);
    const rpBefore = await cdp.evaluate<number>(`${SAVE}.researchP`);
    const charBefore = await cdp.evaluate<number>(`${SAVE}.charId`);

    // 自分以外のカードを押す
    const clicked = await cdp.evaluate<boolean>(`
      (() => {
        const cs = [...document.querySelectorAll('#char-picker .char-card')];
        const other = cs.find(c => !c.classList.contains('selected'));
        if (!other) return false;
        other.click();
        return true;
      })()
    `);
    check('他のキャラを押せる', clicked);
    await sleep(500);

    check('★確認の窓が出る',
      await cdp.evaluate<boolean>('!!document.querySelector(".ask-modal")'));
    const askText = await cdp.evaluate<string>(
      'document.querySelector(".ask-card") ? document.querySelector(".ask-card").innerText : ""');
    check(`かかる研究P(${CHAR_CHANGE_COST})が書いてある`,
      askText.indexOf(String(CHAR_CHANGE_COST)) >= 0,
      askText.replace(/\n/g, ' / ').slice(0, 90));
    check('★窓が出ている間はまだ乗り換わっていない',
      (await cdp.evaluate<number>(`${SAVE}.charId`)) === charBefore);
    await cdp.shot('confirm_char');

    // 「やめる」を押す
    await cdp.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.ask-actions button')]
          .find(x => x.className.indexOf('danger') < 0);
        if (b) b.click();
      })()
    `);
    await sleep(500);
    check('窓が閉じる',
      !await cdp.evaluate<boolean>('!!document.querySelector(".ask-modal")'));
    check('★やめたら研究Pは減らない',
      (await cdp.evaluate<number>(`${SAVE}.researchP`)) === rpBefore,
      `${rpBefore} → ${await cdp.evaluate<number>(`${SAVE}.researchP`)}`);
    check('★やめたらキャラも変わらない',
      (await cdp.evaluate<number>(`${SAVE}.charId`)) === charBefore);

    // 今度は「乗り換える」を押す
    await cdp.evaluate(`
      (() => {
        const cs = [...document.querySelectorAll('#char-picker .char-card')];
        const other = cs.find(c => !c.classList.contains('selected'));
        if (other) other.click();
      })()
    `);
    await sleep(500);
    await cdp.evaluate(`
      (() => {
        const b = document.querySelector('.ask-actions .danger');
        if (b) b.click();
      })()
    `);
    await sleep(700);
    check('★「乗り換える」を押すと乗り換わる',
      (await cdp.evaluate<number>(`${SAVE}.charId`)) !== charBefore,
      `charId ${charBefore} → ${await cdp.evaluate<number>(`${SAVE}.charId`)}`);
    check(`★研究Pが${CHAR_CHANGE_COST}減る`,
      (await cdp.evaluate<number>(`${SAVE}.researchP`)) === rpBefore - CHAR_CHANGE_COST,
      `${rpBefore} → ${await cdp.evaluate<number>(`${SAVE}.researchP`)}`);

    check('最後まで落ちていない', cdp.errors.length === 0,
      cdp.errors.slice(0, 2).join(' / '));
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    await releaseTestNames(HTTP, [{ name: NAME, token: `tok_${NAME}` }]);
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
