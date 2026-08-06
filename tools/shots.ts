// 宣伝用のスクリーンショットを撮る。
//
// 遊び込んだ状態のセーブを流し込んでから、見せたい画面を順に撮る。
// 手で撮ると毎回見た目が違ってしまうので、ここで固定しておく。
//
//   npx tsx tools/shots.ts            … PC向け(1200x750)
//   npx tsx tools/shots.ts --mobile   … スマホ向け(390x844)
//
// 出力: tools/shots/ (gitには入れない)

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;
const MOBILE = process.argv.includes('--mobile');
const OUT = join(import.meta.dirname, 'shots');
const [W, H] = MOBILE ? [390, 844] : [1200, 750];

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

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const b64 = r.result?.data;
    if (!b64) { console.log(`  撮影に失敗: ${name}`); return; }
    const path = join(OUT, `${MOBILE ? 'sp_' : ''}${name}.png`);
    writeFileSync(path, Buffer.from(b64, 'base64'));
    console.log(`  ${path}`);
  }

  // 実際の操作と同じように押す(合成clickでは反応しない箇所がある)
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
    await sleep(500);
    return true;
  }

  close(): void { this.ws.close(); }
}

// 見栄えのする状態のセーブ。魔導書が空だと画面がさびしい。
function seedSave(name: string) {
  const spell = (
    id: string, sname: string, recipe: Record<string, number>,
    discoveries: string[], level: number, rarity: string,
  ) => ({ id, name: sname, recipe, discoveries, level, rarity, stats: {} });

  return {
    version: 1,
    nickname: name,
    nickToken: 'shots',
    charId: 1,
    researchP: 8640,
    inventory: {
      fire: 24, water: 19, wind: 21, earth: 17,
      thunder: 12, ice: 14, light: 6, dark: 5,
    },
    spells: [
      spell('s1', '炎の爆裂弾・極〈火3〉', { fire: 3 }, ['blast'], 4, 'rare'),
      spell('s2', '氷の凍牙〈氷2水〉', { ice: 2, water: 1 }, ['freeze'], 2, 'normal'),
      spell('s3', '雷の連鎖弾・改〈雷2風〉', { thunder: 2, wind: 1 }, ['chain'], 3, 'normal'),
      spell('s4', '光の慈雨〈光2水2〉', { light: 2, water: 2 }, ['rain'], 2, 'epic'),
      spell('s5', '闇の封印〈闇3〉', { dark: 3 }, ['seal'], 1, 'normal'),
      spell('s6', '地の震撼〈土3〉', { earth: 3 }, ['quake'], 2, 'normal'),
    ],
    equipped: ['s1', 's4', 's3', 's2'],
    discovered: [
      'blast', 'freeze', 'chain', 'rain', 'seal', 'quake',
      'burn', 'heal', 'shield', 'taunt', 'ward', 'empower',
    ],
    slots: 4,
    maxStage: 17,
    bestStage: 16,
    bossCleared: [5, 10, 15],
    sortByPower: true,
    codexRewarded: false,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log(`=== 宣伝用スクリーンショット (${MOBILE ? 'スマホ' : 'PC'} ${W}x${H}) ===`);

  const name = `研究者${Math.random().toString(36).slice(2, 5)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${W},${H}`, 'about:blank',
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
    if (!wsUrl) { console.log('  ブラウザを起動できない'); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 2, mobile: MOBILE,
    });

    // 音は要らないので黙らせる。セーブは読み込み前に置く。
    const save = JSON.stringify(seedSave(name));
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try {
          localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(save)});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}
      `,
    });

    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(2500);

    // 1. 研究室(調合台)
    await cdp.click('#tab-lab');
    await sleep(600);
    await cdp.shot('1_lab');

    // 2. 調合台にエレメントを積んだ状態(プレビューが出る)
    //    素材のカードは属性の並び順(火・水・風・土・雷・氷・光・闇)に出る
    for (const nth of [1, 1, 3]) {
      if (!await cdp.click(`#inv-grid .elem-card:nth-child(${nth})`)) {
        console.log(`  (素材が押せない: ${nth}番目)`);
      }
    }
    await sleep(500);
    await cdp.shot('2_craft');

    // 3. 発見図鑑
    await cdp.click('#tab-book');
    await sleep(700);
    await cdp.shot('3_codex');

    // 4. 戦闘の準備画面
    await cdp.click('#tab-battle');
    await sleep(700);
    await cdp.shot('4_battle_setup');

    // 5. 戦闘中
    // ステージ番号のボタンで出撃する(ボスは押せないので手前を選ぶ)
    const started = await cdp.click('#stage-select button:not(.boss):nth-last-child(2)')
      || await cdp.click('#stage-select button:not(.boss)');
    if (started) {
      await sleep(2600);
      await cdp.shot('5_battle');
      await sleep(2500);
      await cdp.shot('6_battle2');
    } else {
      console.log('  (戦闘開始ボタンが見つからない)');
    }

    // 7. オンライン
    await cdp.click('#tab-online');
    await sleep(900);
    await cdp.shot('7_online');
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }
  console.log('完了。');
}

main().catch(e => { console.error(e); process.exit(1); });
