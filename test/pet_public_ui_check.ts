// 公開後、管理者でない人がペットを使えるかを実画面で確かめる。
//
//   npm run dev  … 先に開発サーバーを起こす
//   npx tsx test/pet_public_ui_check.ts
//
// ★ 旗(PETS_PUBLIC)を上げただけでは足りない。
//   画面の中に isAdmin() の判定が散らばっていると、タブは出るのに
//   中身が「管理者モードでのみ利用できます」になる。実際そうなっていた。
//
// ★ 逆に、管理者だけの道具(卵を出す・日を進める)が一般に見えてもいけない。
//   サーバーは合言葉で弾くが、押せるボタンが見えること自体が不自然。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PETS_PUBLIC } from '../shared/pets';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9496;
const OUT = join(process.cwd(), 'tools', 'shots');
const NAME = `pu${Math.random().toString(36).slice(2, 6)}`;
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
  console.log('=== 公開後、管理者でない人のペット画面 ===');
  console.log(`  公開の旗: ${PETS_PUBLIC ? '上がっている' : '下りている'}`);
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pu-'));
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

    await send('Page.enable');
    await send('Runtime.enable');
    // ★ 管理者の合言葉は入れない。一般の人と同じ状態で開く。
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);

    const タブ = await ev<boolean>(
      '!document.querySelector("#tab-pet").classList.contains("hidden")');
    if (タブ !== PETS_PUBLIC) ng++;
    console.log(`  ${タブ === PETS_PUBLIC ? 'OK ' : 'NG '} `
      + `管理者でなくても「ペット」タブが${PETS_PUBLIC ? '出る' : '出ない'} → 実測 ${タブ ? '出た' : '出ない'}`);

    if (!PETS_PUBLIC) { sock.close(); console.log('=== 公開前なのでここまで ==='); process.exit(ng === 0 ? 0 : 1); }

    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);

    const 中身 = await ev<{ 文: string; 管理者用: boolean; 見出し: string }>(`(() => {
      const msg = document.querySelector('#pet-msg');
      const list = document.querySelector('#pet-list');
      const 見出し = [...(list?.querySelectorAll('h3') ?? [])]
        .map(h => h.textContent.trim()).join(' / ');
      return {
        文: msg ? msg.textContent.trim() : '',
        管理者用: 見出し.includes('管理者用'),
        見出し,
      };
    })()`);

    const 断られた = 中身.文.includes('管理者');
    if (断られた) ng++;
    console.log(`  ${断られた ? 'NG ' : 'OK '} 管理者でなくてもペット画面が使える`
      + `${中身.文 ? ` → 実測 「${中身.文}」` : ''}`);

    if (中身.管理者用) ng++;
    console.log(`  ${中身.管理者用 ? 'NG ' : 'OK '} 管理者用の道具(卵を出す・日を進める)が一般に見えない`);
    console.log(`     画面の見出し: ${中身.見出し || '(なし)'}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'pet_public_ui.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/pet_public_ui.png');
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
