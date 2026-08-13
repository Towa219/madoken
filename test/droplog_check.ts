// 切断の記録が本当に残るかを、回線を切って確かめる。
//
//   npm run dev / PORT=2568 npm run dev:server を先に起こす
//   npx tsx test/droplog_check.ts
//
// ★ 仕込んだだけで満足しないこと。この記録は「再現しない切断を
//   追う唯一の手掛かり」なので、いざ切れた時に何も残らなければ
//   仕込んだ意味がまるごと無くなる。実際に切って、残るところまで見る。
//
// ★ 切り方は CDP の Network.emulateNetworkConditions(offline)。
//   サーバーを止めて試すと、他の検証や遊んでいる人を巻き込む。

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9510;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `dl${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 3 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 10, bestStage: 5,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 切断の記録 ===');
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'madoken-dl-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1100,1200', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!ws) { console.log('  NG  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const 待ち = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && 待ち.has(m.id)) { 待ち.get(m.id)!(m); 待ち.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; 待ち.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        // ★ 検証から接続を切れるようにしておく。
        //   オフラインにするだけでは既に開いている接続は閉じず、
        //   TCPが諦めるまで何十秒も切断が伝わらない(実際に空振りした)。
        const 元WS = window.WebSocket;
        window.__sockets = [];
        window.WebSocket = function (...a) {
          const s = new 元WS(...a);
          window.__sockets.push(s);
          return s;
        };
        window.WebSocket.prototype = 元WS.prototype;
        Object.assign(window.WebSocket, 元WS);
      } catch {}`,
    });
    await send('Page.navigate', { url: PAGE });
    await sleep(6000);

    // ---- 最初は空であること ----
    await ev('document.getElementById("tab-settings").click()');
    await sleep(1200);
    const 最初 = await ev<string>(
      '(document.querySelector("#drop-log")?.textContent || "").trim()');
    確認('設定に「切断の記録」の欄がある', 最初.length > 0, `実測 「${最初.slice(0, 40)}」`);
    確認('まだ何も記録されていない', 最初.includes('まだ記録がありません'));

    // ---- 共闘部屋を作って、回線を切る ----
    await ev('document.getElementById("tab-battle").click()');
    await sleep(1200);
    const 作れた = await ev<boolean>(`(() => {
      const b = document.getElementById('btn-create-room');
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`);
    確認('共闘部屋を作れた', 作れた);
    await sleep(4000);

    const 入れた = await ev<boolean>(
      '!document.getElementById("coop-screen")?.classList.contains("hidden")'
      + ' || !!document.querySelector("#coop-waiting")');
    console.log(`     部屋に入った: ${入れた}`);

    // ★ 接続を閉じる。サーバーは止めない(他の検証や遊んでいる人を
    //   巻き込まないため)。4001 は「前触れなく切れた」の代わり。
    const 閉じた = await ev<number>(`(() => {
      const ss = (window.__sockets || []).filter(s => s.readyState === 1);
      for (const s of ss) s.close(4001, '検証');
      return ss.length;
    })()`);
    console.log(`     開いていた接続を${閉じた}本閉じました。伝わるのを待ちます…`);
    確認('閉じられる接続があった', 閉じた > 0, `${閉じた}本`);
    await sleep(8000);

    // ---- 記録が残ったか ----
    const 記録 = await ev<string>(`(() => {
      try {
        const raw = localStorage.getItem('madoken_drops_v1');
        return raw ? raw : '(空)';
      } catch { return '(読めない)'; }
    })()`);
    console.log(`     残った記録: ${記録.slice(0, 220)}`);
    確認('切断が記録された', 記録 !== '(空)' && 記録.length > 5);
    確認('理由(コード)が入っている', /code=\d+/.test(記録),
      (記録.match(/code=\d+[^"]*/) ?? ['入っていない'])[0]);

    await sleep(1000);
    await ev('document.getElementById("tab-settings").click()');
    await sleep(1200);
    const 画面 = await ev<string>(
      '(document.querySelector("#drop-log")?.textContent || "").trim()');
    確認('設定の画面にも出ている', !画面.includes('まだ記録がありません') && 画面.length > 5,
      `実測 「${画面.slice(0, 70)}」`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(SHOTS, 'droplog.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/droplog.png');
    }
    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }

  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
