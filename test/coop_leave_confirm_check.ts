// 共闘の戦闘画面で「退出」を押した時、確認が出るかを実際に押して確かめる。
//
//   npm run dev / PORT=2568 ADMIN_KEY=test1234 npm run dev:server を起こす
//   PET_TEST_URL=http://localhost:2568 npx tsx test/coop_leave_confirm_check.ts
//
// ★ 「窓が出た」だけでは足りない。「やめる」を押した時に**退出していない**
//   ことまで見る。確認を足したつもりで、押した瞬間に抜けているのでは
//   何も守れていない。
//
// ★ 決着後(done)は聞かないことも見る。もう失うものが無いのに毎回聞くと
//   ただの邪魔になるので、そこは素通りさせている。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9514;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `lc${Math.random().toString(36).slice(2, 6)}`;
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
  console.log('=== 共闘の退出に確認が出るか ===');
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'madoken-lc-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1100,1000', 'about:blank',
  ], { stdio: 'ignore' });

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
      } catch {}`,
    });
    await send('Page.navigate', { url: PAGE });
    await sleep(6000);

    // ---- ロビーへ繋いで共闘部屋を作る ----
    await ev('document.getElementById("tab-battle").click()');
    await sleep(800);
    await ev(`(() => {
      const b = document.getElementById('btn-connect');
      if (b && !b.disabled) b.click();
    })()`);
    let ロビー = false;
    for (let i = 0; i < 30 && !ロビー; i++) {
      await sleep(1000);
      ロビー = await ev<boolean>(
        '!document.getElementById("online-lobby")?.classList.contains("hidden")');
    }
    確認('ロビーに入れた', ロビー);
    if (!ロビー) throw new Error('ロビーに入れなかった');

    await ev('document.getElementById("btn-create-room").click()');
    await sleep(4000);
    await ev(`(() => {
      const b = document.getElementById('btn-coop-ready');
      if (b) b.click();
    })()`);

    // 戦闘が始まる(退出ボタンは戦闘中の魔法バーに出る)まで待つ
    let 戦闘中 = false;
    for (let i = 0; i < 40 && !戦闘中; i++) {
      await sleep(1000);
      戦闘中 = await ev<boolean>(
        '!!document.querySelector("#coop-bar #btn-escape")'
        + ' && document.querySelectorAll("#coop-bar .spell-btn").length > 0');
    }
    確認('戦闘画面に退出ボタンが出ている', 戦闘中);
    if (!戦闘中) throw new Error('戦闘が始まらなかった');

    // ---- 押す ----
    await ev('document.querySelector("#coop-bar #btn-escape").click()');
    await sleep(900);
    const 窓 = await ev<string>(`(() => {
      const m = document.querySelector('.ask-modal');
      return m ? (m.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    })()`);
    確認('確認の窓が出た', 窓.length > 0, `実測 「${窓.slice(0, 60)}」`);
    確認('戦果が消えることが書いてある', 窓.includes('記録されません'));
    // ★ 窓を開けている間も戦闘は止まらない。止めると「開けているあいだは
    //   無敵」になるので止めていない。そのぶん必ず書いておく。
    確認('戦闘が止まらないと書いてある', 窓.includes('止まりません'));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(SHOTS, 'coop_leave_confirm.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/coop_leave_confirm.png');
    }

    // ---- 「やめる」で退出しないこと ----
    await ev(`(() => {
      const bs = [...document.querySelectorAll('.ask-modal .ask-actions button')];
      const no = bs.find(b => (b.textContent || '').includes('やめる'));
      if (no) no.click();
    })()`);
    await sleep(1200);
    const 残っている = await ev<boolean>(
      '!!document.querySelector("#coop-bar #btn-escape")'
      + ' && !document.getElementById("coop-view")?.classList.contains("hidden")');
    確認('「やめる」を押したら退出していない', 残っている);

    // ---- 「退出する」で実際に抜けること ----
    await ev('document.querySelector("#coop-bar #btn-escape").click()');
    await sleep(900);
    await ev(`(() => {
      const bs = [...document.querySelectorAll('.ask-modal .ask-actions button')];
      const yes = bs.find(b => (b.textContent || '').includes('退出する'));
      if (yes) yes.click();
    })()`);
    await sleep(2500);
    const 抜けた = await ev<boolean>(
      'document.getElementById("coop-view")?.classList.contains("hidden") === true');
    確認('「退出する」を押したら実際に抜ける', 抜けた);

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
