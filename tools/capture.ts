// 宣伝用の画面録画を撮る。
//
// ヘッドレスChromeに実際に遊ばせながら、CDPの画面配信(screencast)で
// 1コマずつ受け取り、ffmpegでmp4とgifに組み立てる。
// 手で録ると毎回尺も内容も変わってしまうので、台本を固定してある。
//
// 台本(およそ25秒):
//   1. 研究室で素材を1つずつ調合台へ置く → ???(未知の反応)が出る
//   2. 調合する → 進捗バー → 新系統を発見
//   3. 戦闘へ移り、ステージを選んで開戦
//   4. 魔法を撃って敵を倒す
//
//   npx tsx tools/capture.ts
//
// 出力: tools/shots/promo.mp4 と promo.gif (gitには入れない)

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG = process.env.FFMPEG_PATH
  ?? 'C:\\Users\\ai_to\\AppData\\Local\\Microsoft\\WinGet\\Packages'
   + '\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
   + '\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe';
const PORT = 9355;
const OUT = join(import.meta.dirname, 'shots');
const FPS = 20;
const W = 1200;
const H = 720;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  private onEvent = new Map<string, (p: any) => void>();

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
      const fn = this.onEvent.get(m.method);
      if (fn) fn(m.params);
    };
  }

  on(method: string, fn: (p: any) => void): void { this.onEvent.set(method, fn); }

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

  async click(sel: string, nth = 0): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const list = document.querySelectorAll(${JSON.stringify(sel)});
        const e = list[${nth}];
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
    return true;
  }

  async key(text: string): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type, text: type === 'keyDown' ? text : undefined,
        key: text, code: `Digit${text}`,
        windowsVirtualKeyCode: text.charCodeAt(0),
      });
    }
  }

  close(): void { this.ws.close(); }
}

// 撮影用のセーブ。素材を持っていて、まだ火2風は発見していない状態にする。
// 動画の見せ場が「未知の反応 → 新系統を発見」なので、そこを未発見で残す。
function seedSave(name: string) {
  const spell = (
    id: string, sname: string, recipe: Record<string, number>, level: number, rarity: string,
  ) => ({ id, name: sname, recipe, discoveries: [], level, rarity, stats: {} });

  return {
    version: 1,
    nickname: name,
    nickToken: 'capture',
    charId: 1,
    researchP: 5200,
    inventory: {
      fire: 26, water: 18, wind: 22, earth: 15,
      thunder: 13, ice: 12, light: 7, dark: 6,
    },
    spells: [
      spell('s1', '炎の爆裂弾・極〈火3〉', { fire: 3 }, 4, 'rare'),
      spell('s2', '氷の凍牙〈氷2水〉', { ice: 2, water: 1 }, 2, 'normal'),
      spell('s3', '雷の連鎖弾・改〈雷2風〉', { thunder: 2, wind: 1 }, 3, 'normal'),
      spell('s4', '光の慈雨〈光2水2〉', { light: 2, water: 2 }, 2, 'epic'),
    ],
    equipped: ['s1', 's4', 's3', 's2'],
    discovered: ['blast', 'freeze', 'chain', 'rain'],
    slots: 4,
    maxStage: 9,
    bestStage: 8,
    bossCleared: [5],
    sortByPower: true,
    codexRewarded: false,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const frames = mkdtempSync(join(tmpdir(), 'madoken-frames-'));
  console.log(`=== 宣伝用の画面録画 (${W}x${H} / ${FPS}fps) ===`);

  const name = `研究者${Math.random().toString(36).slice(2, 5)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-cap-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  let n = 0;
  let started = 0;
  let elapsed = 0;
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
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });

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

    // 画面配信を受け取る。届いたコマをそのまま連番で書き出す。
    cdp.on('Page.screencastFrame', (p: { data: string; sessionId: number }) => {
      writeFileSync(join(frames, `f${String(++n).padStart(5, '0')}.jpg`),
        Buffer.from(p.data, 'base64'));
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId });
    });

    console.log('  録画開始');
    started = Date.now();
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1,
    });

    // --- 1. 素材を1つずつ調合台へ ---
    await cdp.click('#tab-lab');
    await sleep(1400);
    for (const nth of [0, 0, 2]) {           // 火・火・風
      await cdp.click('#inv-grid .elem-card', nth);
      await sleep(900);
    }
    await sleep(1800);                        // ???(未知の反応)を読ませる間

    // --- 2. 調合する ---
    await cdp.click('#btn-craft');
    await sleep(4200);                        // 進捗バー + 発見の演出

    // --- 3. 戦闘へ ---
    await cdp.click('#tab-battle');
    await sleep(1500);
    const stages = await cdp.evaluate<number>(
      'document.querySelectorAll("#stage-select button:not(.boss)").length');
    await cdp.click('#stage-select button:not(.boss)', Math.max(0, stages - 1));
    await sleep(4000);                        // 3・2・1・開戦

    // --- 4. 魔法を撃つ ---
    for (const k of ['1', '2', '1', '3', '1', '4', '1', '1']) {
      await cdp.key(k);
      await sleep(1500);
    }
    await sleep(2500);

    await cdp.send('Page.stopScreencast');
    elapsed = (Date.now() - started) / 1000;
    console.log(`  録画終了 (${n}コマ / ${elapsed.toFixed(1)}秒)`);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  if (n < 10) { console.log('  コマが少なすぎる。組み立てを中止する。'); return; }

  // 届くコマ数は描画の忙しさで毎回変わる。20fps決め打ちで組み立てると
  // 30秒の操作が113秒の動画になってしまうので、実時間から本当のfpsを出す。
  const inFps = Math.max(1, n / Math.max(1, elapsed));
  console.log(`  取り込み ${inFps.toFixed(1)}fps → 出力 ${FPS}fps`);
  const mp4 = join(OUT, 'promo.mp4');
  const gif = join(OUT, 'promo.gif');
  const run = (args: string[]) => {
    const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
    if (r.status !== 0) console.log(r.stderr?.slice(-800));
    return r.status === 0;
  };

  console.log('  mp4を作る…');
  run(['-y', '-framerate', inFps.toFixed(3), '-i', join(frames, 'f%05d.jpg'),
    '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-movflags', '+faststart', mp4]);

  // Xはgifも受け付けるが重くなるので、幅720に落として色数を最適化する
  console.log('  gifを作る…');
  const pal = join(frames, 'pal.png');
  run(['-y', '-framerate', inFps.toFixed(3), '-i', join(frames, 'f%05d.jpg'),
    '-vf', 'fps=14,scale=720:-1:flags=lanczos,palettegen=max_colors=192', pal]);
  run(['-y', '-framerate', inFps.toFixed(3), '-i', join(frames, 'f%05d.jpg'), '-i', pal,
    '-lavfi', 'fps=14,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3',
    gif]);

  try { rmSync(frames, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  console.log(`\n${mp4}\n${gif}`);
}

main().catch(e => { console.error(e); process.exit(1); });
