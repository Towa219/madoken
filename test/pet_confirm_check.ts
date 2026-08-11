// 手放す・預ける時に確認の窓が出るかを、実際に押して確かめる。
//
//   npm run dev  … 先に開発サーバーを起こす
//   ADMIN_KEY=test1234 npx tsx test/pet_confirm_check.ts
//
// ★ 「コードに askConfirm がある」だけでは足りない。
//   窓が実際に画面へ出て、「やめる」で操作が起きないところまで見る。
//   出ていなければ、押した瞬間にペットが消える。取り返しがつかない。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const PORT = 9498;
const OUT = join(process.cwd(), 'tools', 'shots');
const NAME = `pc${Math.random().toString(36).slice(2, 6)}`;
// ★ 画面は5173番、APIは2567番。相対パスで投げると404になる
//   (src/pet.ts の apiBase() が開発中は2567番を指しているのと同じ理由)。
const API = process.env.PET_API ?? 'http://localhost:2567';
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
  console.log('=== 手放す・預ける の確認窓 ===');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pc-'));
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
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        sessionStorage.setItem('madoken_admin_key', ${JSON.stringify(KEY)});
      } catch {}`,
    });
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);

    // 卵を1つ用意する(管理者の道具を使う)
    const 用意 = await ev<string>(`(async () => {
      const r = await fetch(${JSON.stringify(API)} + '/api/pet/grant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ${JSON.stringify(KEY)}, name: ${JSON.stringify(NAME)},
                               token: 'tok_' + ${JSON.stringify(NAME)}, stage: 1 }),
      });
      return r.status === 200 ? 'OK' : '卵を出せない:' + r.status;
    })()`);
    if (用意 !== 'OK') { console.log(`  NG  ${用意}`); process.exit(1); }

    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);

    const 前の数 = await ev<number>(
      'document.querySelectorAll("#pet-list .panel").length');
    console.log(`  卵を1つ用意した(画面の枠=${前の数}個)`);

    // 「手放す」を押す
    const 押した = await ev<string>(`(() => {
      const b = [...document.querySelectorAll('#pet-list button')]
        .find(x => (x.textContent || '').trim() === '手放す');
      if (!b) return '手放すボタンが無い';
      b.click(); return 'OK';
    })()`);
    if (押した !== 'OK') { console.log(`  NG  ${押した}`); ng++; }
    await sleep(900);

    const 窓 = await ev<{ 出た: boolean; 題: string; 文: string; 押せる: string[] }>(`(() => {
      const card = document.querySelector('.ask-modal .ask-card');
      if (!card) return { 出た: false, 題: '', 文: '', 押せる: [] };
      return {
        出た: true,
        題: (card.querySelector('h3')?.textContent || '').trim(),
        文: (card.querySelector('p')?.textContent || '').trim(),
        押せる: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
      };
    })()`);

    if (!窓.出た) ng++;
    console.log(`  ${窓.出た ? 'OK ' : 'NG '} 手放すを押すと確認の窓が出る`);
    if (窓.出た) {
      console.log(`     題: ${窓.題}`);
      console.log(`     文: ${窓.文}`);
      console.log(`     ボタン: ${窓.押せる.join(' / ')}`);
    }

    // 「やめる」で消えないこと
    await ev(`(() => {
      const b = [...document.querySelectorAll('.ask-card button')]
        .find(x => /やめる|いいえ/.test(x.textContent || ''));
      if (b) b.click();
    })()`);
    await sleep(1500);
    const 残り = await ev<number>('document.querySelectorAll("#pet-list .panel").length');
    const 残った = 残り === 前の数;
    if (!残った) ng++;
    console.log(`  ${残った ? 'OK ' : 'NG '} 「やめる」を押すと卵は消えない → 実測 枠${残り}個`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'pet_confirm.png'), Buffer.from(shot.result.data, 'base64'));
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
