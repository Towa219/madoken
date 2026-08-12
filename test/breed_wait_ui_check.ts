// 交配の2つの待ちが、実際の画面でそう見えるかを確かめる。
//
//   npm run dev / ADMIN_KEY=test1234 npm run dev:server を先に起こす
//   ADMIN_KEY=test1234 npx tsx test/breed_wait_ui_check.ts
//
// ★ test/breed_wait_check.ts は式だけを見ている。こちらは画面を見る。
//   判定が正しくても、巣のカードに温めるボタンが残っていれば
//   遊ぶ人には「押せるのに何も起きない」としか映らない。
//
// ★ 「文字が出ている」だけでは足りない。時間を進めて、巣が卵に
//   変わり、温めるボタンが出るところまで見る。変わらなければ
//   卵は永久に巣のままで、そのペットは死ぬまで触れない。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_SETTLE_HOURS, BREED_EGG_HOURS } from '../shared/pets';

const API = process.env.PET_API ?? 'http://127.0.0.1:2567';
const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const PORT = 9504;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `bw${Math.random().toString(36).slice(2, 6)}`;

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
    spells: [], equipped: [],
    discovered: [], slots: 4, maxStage: 3, bestStage: 2,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

const 叩く = (path: string, extra: Record<string, unknown> = {}) =>
  fetch(`${API}/api/pet/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, name: NAME, token: `tok_${NAME}`, ...extra }),
  }).then(r => r.json() as Promise<Record<string, any>>);

// 成鳥を必要な数そろえる。
//
// ★ 時間を進めるだけでは孵らない。孵化は温めた回数で決まるので、
//   間隔を空けるために日を進めながら、実際に温める。
// ★ 進めすぎないこと。寿命(雛4日+成鳥20日前後+老鳥5日)を越えると
//   そろえたそばから天へ行ってしまう。
async function 成鳥をそろえる(数: number): Promise<any[]> {
  for (let i = 0; i < 数; i++) await 叩く('grant', { stage: (i % 5) + 1 });
  for (let 回 = 0; 回 < 4; 回++) {
    await 叩く('advance', { days: 1 });
    const 手持ち = (await 叩く('list')).pets as { id: string; species: unknown }[] | undefined;
    for (const p of (手持ち ?? []).filter(x => !x.species)) await 叩く('warm', { petId: p.id });
  }
  await 叩く('advance', { days: 6 });   // 雛(4日)を抜けて成鳥にする
  return ((await 叩く('list')).pets as any[] ?? []).filter(p => p.species);
}

async function main(): Promise<void> {
  console.log('=== 交配の待ちを画面で見る ===');
  console.log(`  なじみ ${BOARD_SETTLE_HOURS}時間 / 巣 ${BREED_EGG_HOURS}時間`);
  mkdirSync(SHOTS, { recursive: true });

  // ♂と♀が要る。性別は選べないので多めに出してから選ぶ。
  const 鳥 = await 成鳥をそろえる(5);
  const 雄 = 鳥.find(p => p.sex === 'm');
  const 雌 = 鳥.find(p => p.sex === 'f');
  if (!雄 || !雌) {
    console.log(`  NG  ♂♀がそろわなかった(${鳥.map(p => p.sex).join('')})`);
    process.exit(1);
  }

  // ★ 先に1羽預けること。手持ちが上限だと交配そのものを断られる
  //   (卵の置き場が無いため)。預けた鳥は手持ちの数に入らないので、
  //   なじみ待ちを見るのと枠を空けるのを兼ねられる。
  const 預ける相手 = 鳥.find(p => p.id !== 雄.id && p.id !== 雌.id);
  if (預ける相手) await 叩く('board', { petId: 預ける相手.id });

  const 交配 = await 叩く('breed', { petId: 雄.id, partnerId: 雌.id });
  確認('交配できた', 交配.ok === true, 交配.error ?? '');
  if (!交配.ok) process.exit(1);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bw-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,1200', 'about:blank',
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
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        sessionStorage.setItem('madoken_admin_key', ${JSON.stringify(KEY)});
      } catch {}`,
    });

    const 開く = async (): Promise<void> => {
      await send('Page.navigate', { url: PAGE });
      await sleep(6000);
      await ev('document.querySelector("#tab-pet").click()');
      await sleep(2500);
    };
    // 画面のどこかに出ている文字を全部拾う(カードの並びに依存しないため)
    const 本文 = () => ev<string>(
      '(document.querySelector("#pet-list")?.textContent || "").replace(/\\s+/g, " ")');
    const 温めるボタンの数 = () => ev<number>(`
      [...document.querySelectorAll('#pet-list button')]
        .filter(b => (b.textContent || '').trim() === '温める').length`);

    await 開く();

    // ---- 1. 巣ができている ----
    const 一回目 = await 本文();
    確認('巣のカードが出ている', 一回目.includes('🪺 巣'),
      (一回目.match(/🪺[^ ]*/) ?? ['出ていない'])[0]);
    // ★ まだ卵は無い。名前が無い時の既定「たまご」が出ると
    //   「たまご 巣」というちぐはぐな見出しになる。
    確認('巣を「たまご」と呼んでいない', !一回目.includes('たまご'));
    確認('卵ができるまでの残りが出ている', /卵ができるまで あと\d/.test(一回目),
      (一回目.match(/卵ができるまで あと[^ ]*/) ?? ['出ていない'])[0]);
    確認('巣に殻の手がかりを出していない',
      !一回目.includes('殻は'), '(卵がまだ無いのに殻の話は出さない)');
    確認('巣に温めるボタンを出していない', (await 温めるボタンの数()) === 0,
      `温めるボタン ${await 温めるボタンの数()}個`);

    // ---- 2. 預けた鳥のなじみ待ち ----
    if (預ける相手) {
      確認('なじむまでの残りが出ている', /なじむまで あと\d/.test(一回目),
        (一回目.match(/なじむまで あと[^ ]*/) ?? ['出ていない'])[0]);
    }

    const 撮る = async (名: string): Promise<void> => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      if (s.result?.data) {
        writeFileSync(join(SHOTS, `${名}.png`), Buffer.from(s.result.data, 'base64'));
        console.log(`  撮影: tools/shots/${名}.png`);
      }
    };
    await 撮る('breed_nest');

    // ---- 3. 時間を進めると巣が卵になる ----
    //
    // ★ ここが本番。変わらなければ卵は永久に巣のままで、
    //   そのペットは死ぬまで触れない。
    await 叩く('advance', { days: BREED_EGG_HOURS / 24 });
    await 開く();
    const 二回目 = await 本文();
    確認('巣が卵に変わった', !二回目.includes('卵ができるまで'),
      二回目.includes('まだ卵') ? '「まだ卵」になった' : 二回目.slice(0, 90));
    確認('卵になったら殻の手がかりが出る', 二回目.includes('殻は'));
    確認('卵になった瞬間から温められる', (await 温めるボタンの数()) > 0,
      `温めるボタン ${await 温めるボタンの数()}個`);
    await 撮る('breed_egg');

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
