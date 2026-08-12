// 卵の「温められるまであと○分」が、実際に数えているかを確かめる。
//
//   npm run dev  … 先に開発サーバーを起こす
//   ADMIN_KEY=test1234 npx tsx test/egg_countdown_check.ts
//
// ★ 「文字が出ている」だけでは足りない。描いた時の値を貼っただけだと、
//   開いたまま待つ人には何分経っても同じ数字が見え続ける。
//   時間を進めて、数字が本当に減るところまで見る。
//
// ★ 端末の時計ではなくサーバーの時計で数えているかも見る。
//   孵化も寿命もサーバー側で判定しているので、ここだけ端末時計だと
//   「あと0分なのに押せない」という食い違いが起きる。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WARM_INTERVAL_MS } from '../shared/pets';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const API = process.env.PET_API ?? 'http://localhost:2567';
const PORT = 9500;
const OUT = join(process.cwd(), 'tools', 'shots');
const NAME = `ec${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 50, bestStage: 50,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 卵の残り時間 ===');
  console.log(`  温めの間隔: ${WARM_INTERVAL_MS / 3600000}時間`);
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'ec-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1000,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!ws) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const wait = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; wait.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    const 叩く = async (path: string, extra: Record<string, unknown> = {}) =>
      fetch(`${API}/api/pet/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KEY, name: NAME, token: `tok_${NAME}`, ...extra }),
      }).then(r => r.json() as Promise<Record<string, unknown>>);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        sessionStorage.setItem('madoken_admin_key', ${JSON.stringify(KEY)});
      } catch {}`,
    });

    await 叩く('grant', { stage: 1 });
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);

    const 読む = () => ev<string>(`(() => {
      const el = document.querySelector('#pet-list .egg-left');
      return el ? (el.textContent || '').trim() : '(無い)';
    })()`);
    const 押せるか = () => ev<boolean>(`(() => {
      const b = [...document.querySelectorAll('#pet-list button')]
        .find(x => (x.textContent || '').trim() === '温める');
      return b ? !b.disabled : false;
    })()`);

    const 出たてすぐ = await 読む();
    const 出ている = 出たてすぐ.includes('あと') && /\d/.test(出たてすぐ);
    if (!出ている) ng++;
    console.log(`  ${出ている ? 'OK ' : 'NG '} 残り時間が出ている → 実測 「${出たてすぐ}」`);

    const 分だけ = /あと\d+分$/.test(出たてすぐ) || /あと\d+時間\d*分?$/.test(出たてすぐ);
    if (!分だけ) ng++;
    console.log(`  ${分だけ ? 'OK ' : 'NG '} 分まで出ている(「約1時間」で丸めていない)`);

    const 押せる1 = await 押せるか();
    if (押せる1) ng++;
    console.log(`  ${押せる1 ? 'NG ' : 'OK '} まだ温めるボタンは押せない`);

    // ★ 時間を進めて、数字が本当に減るか見る。
    //   間隔ぶんまるごと進めると0になるので、少しだけ手前まで進める。
    const 進める日 = (WARM_INTERVAL_MS - 3 * 60000) / 86400000;   // 残り3分の所まで
    await 叩く('advance', { days: 進める日 });
    // 画面を開き直して取り直す(見張りは30秒ごとなので待たずに済ませる)
    await ev('document.querySelector("#tab-lab").click()');
    await sleep(400);
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);

    const 進めた後 = await 読む();
    console.log(`     進めた後: 「${進めた後}」`);
    const 減った = /あと[1-5]分/.test(進めた後);
    if (!減った) ng++;
    console.log(`  ${減った ? 'OK ' : 'NG '} 時間を進めると数字が減る`);

    // さらに進めて0にし、押せるようになるか
    await 叩く('advance', { days: 10 / 1440 });   // 10分ぶん
    await ev('document.querySelector("#tab-lab").click()');
    await sleep(400);
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);
    const 満了 = await 読む();
    const 押せる2 = await 押せるか();
    console.log(`     満了後: 「${満了}」`);
    if (!押せる2) ng++;
    console.log(`  ${押せる2 ? 'OK ' : 'NG '} 時間が来ると温めるボタンが押せる`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'egg_countdown.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/egg_countdown.png');
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
