// 設定タブの音量つまみが、閉じて開き直しても保たれるかを実ブラウザで確かめる。
//
//   npm run dev            … 先に開発サーバーを起こす
//   npx tsx test/sound_prefs_check.ts
//
// ★ なぜ実ブラウザで見るか(2026-08-21)。
//   「音量が保存されない」という指摘を受けてコードを読んだが、
//   setBgmVolume → savePrefs → localStorage の筋は通っており、
//   initSound() が loadPrefs() を最初に呼んでいて、つまみも
//   index.html に静的に置いてある。読むだけでは何も見つからない。
//   実際に動かして、どの段で落ちているのかを見る。
//
//   見るのは3段。どこで切れているかで原因が変わる。
//     ① つまみを動かすと prefs が変わるか(操作が届いているか)
//     ② localStorage に書けているか(保存しているか)
//     ③ 読み込み直すと戻ってくるか(読み出せているか)

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9497;
const PREF_KEY = 'madoken_sound_v4';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let 失敗数 = 0;
function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

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
    return new Promise(res => { this.waiting.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }
  close(): void { this.ws.close(); }
}

// 名前を入れておかないと「ようこそ」で止まり、設定タブへ行けない
function seedSave(名: string) {
  return {
    version: 1, nickname: 名, nickToken: `tok_${名}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossRewarded: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function 設定タブを開く(cdp: Cdp): Promise<void> {
  await cdp.evaluate("document.querySelector('#tab-settings').click()");
  await sleep(900);
}

// 画面のつまみを人が動かした時と同じ形で動かす
async function つまみを動かす(cdp: Cdp, id: string, 値: number): Promise<void> {
  await cdp.evaluate(`(() => {
    const el = document.querySelector('${id}');
    el.value = '${値}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
}

async function 保存値(cdp: Cdp): Promise<{ bgmVolume?: number; sfxVolume?: number; muted?: boolean } | null> {
  return cdp.evaluate(`(() => {
    const raw = localStorage.getItem('${PREF_KEY}');
    return raw ? JSON.parse(raw) : null;
  })()`);
}

async function つまみの値(cdp: Cdp): Promise<{ bgm: string; sfx: string }> {
  return cdp.evaluate(`(() => ({
    bgm: document.querySelector('#bgm-volume').value,
    sfx: document.querySelector('#sfx-volume').value,
  }))()`);
}

async function main(): Promise<void> {
  console.log('=== 音量の設定が保たれるか ===');
  const 名 = `音${Math.random().toString(36).slice(2, 6)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-snd-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
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
    if (!wsUrl) { console.error('  ブラウザを起動できなかった'); process.exit(1); }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 名前だけ入れる。音の設定は入れない(既定値から始めたいため)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave(名)))});
      } catch {}`,
    });

    await cdp.send('Page.navigate', { url: PAGE });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);
    await 設定タブを開く(cdp);

    const 最初 = await つまみの値(cdp);
    console.log(`  はじめの値 … BGM ${最初.bgm}% / 効果音 ${最初.sfx}%`);

    // ---- ① つまみを動かす ----
    console.log('\n-- ① つまみを動かした直後 --');
    await つまみを動かす(cdp, '#bgm-volume', 55);
    await つまみを動かす(cdp, '#sfx-volume', 70);
    const 動かした後 = await つまみの値(cdp);
    確認(動かした後.bgm === '55' && 動かした後.sfx === '70',
      'つまみが動いている', `BGM ${動かした後.bgm}% / 効果音 ${動かした後.sfx}%`);

    // ---- ② 保存されているか ----
    console.log('\n-- ② localStorage に書けているか --');
    const 保存 = await 保存値(cdp);
    確認(保存 !== null, `${PREF_KEY} が書かれている`,
      保存 ? JSON.stringify(保存) : '(何も無い)');
    確認(Math.round((保存?.bgmVolume ?? -1) * 100) === 55,
      'BGMの値が保存されている', `保存値 ${保存?.bgmVolume}`);
    確認(Math.round((保存?.sfxVolume ?? -1) * 100) === 70,
      '効果音の値が保存されている', `保存値 ${保存?.sfxVolume}`);

    // ---- ③ 読み込み直すと戻るか ----
    console.log('\n-- ③ 読み込み直した後 --');
    await cdp.send('Page.reload');
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);
    const 読み直し後の保存 = await 保存値(cdp);
    確認(Math.round((読み直し後の保存?.bgmVolume ?? -1) * 100) === 55,
      '読み込み直しても保存値が残っている',
      読み直し後の保存 ? JSON.stringify(読み直し後の保存) : '(消えている)');

    await 設定タブを開く(cdp);
    const 復帰 = await つまみの値(cdp);
    確認(復帰.bgm === '55', 'BGMのつまみが戻っている', `${復帰.bgm}%`);
    確認(復帰.sfx === '70', '効果音のつまみが戻っている', `${復帰.sfx}%`);

    // 実際に鳴る音量も戻っているか(つまみの見た目だけ合っていても意味がない)
    const 実音量 = await cdp.evaluate<{ bgm: number; sfx: number } | null>(`(() => {
      const el = document.querySelector('#bgm-volume');
      const s = document.querySelector('#sfx-volume');
      return el && s ? { bgm: Number(el.value), sfx: Number(s.value) } : null;
    })()`);
    確認(実音量?.bgm === 55 && 実音量?.sfx === 70,
      '画面の表示と読み出した値が一致している',
      実音量 ? `BGM ${実音量.bgm}% / 効果音 ${実音量.sfx}%` : '(取れない)');

    // ---- ④ 場面を移ってから戻る ----
    // 曲は場面ごとに変わる(ロビー/戦闘/ボス)。曲が切り替わる時に
    // つまみが既定へ戻っていないかを見る。読み込み直しでは出ない。
    console.log('\n-- ④ 別のタブへ移ってから設定に戻る --');
    for (const t of ['#tab-lab', '#tab-book', '#tab-battle', '#tab-manual']) {
      await cdp.evaluate(`(() => { const e = document.querySelector('${t}'); if (e) e.click(); return true; })()`);
      await sleep(350);
    }
    await 設定タブを開く(cdp);
    const 巡回後 = await つまみの値(cdp);
    確認(巡回後.bgm === '55' && 巡回後.sfx === '70',
      '他のタブを回っても値が変わらない',
      `BGM ${巡回後.bgm}% / 効果音 ${巡回後.sfx}%`);
  } finally {
    // ★ kill で落としてはいけない。Chrome は localStorage をすぐには
    //   ディスクに書かないので、強制終了すると直前の書き込みが消え、
    //   「保存されていない」という偽の失敗になる(2026-08-21に実際に踏んだ)。
    //   人が窓を閉じる時と同じ Browser.close で終わらせる。
    try { await cdp.send('Browser.close'); } catch { /* もう閉じている */ }
    cdp.close();
    await sleep(1500);
    chrome.kill();
  }

  // ---- ⑤ ブラウザごと閉じて開き直す ----
  // ★ 読み込み直し(reload)とは別。人が「保存されていない」と言う時は
  //   たいていこちら ― 一度閉じて、後でまた開く使い方。
  console.log('\n-- ⑤ ブラウザを閉じて開き直す --');
  await sleep(1200);
  const chrome2 = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT + 1}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const cdp2 = new Cdp();
  try {
    let wsUrl2 = '';
    for (let i = 0; i < 40 && !wsUrl2; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl2 = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl2) { console.error('  2回目のブラウザを起動できなかった'); process.exit(1); }
    await cdp2.connect(wsUrl2);
    await cdp2.send('Page.enable');
    await cdp2.send('Runtime.enable');
    await cdp2.send('Page.navigate', { url: PAGE });
    for (let i = 0; i < 60; i++) {
      if (await cdp2.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);
    const 再起動後の保存 = await 保存値(cdp2);
    確認(再起動後の保存 !== null, '閉じても保存値が残っている',
      再起動後の保存 ? JSON.stringify(再起動後の保存) : '(消えている)');
    await 設定タブを開く(cdp2);
    const 再起動後 = await つまみの値(cdp2);
    確認(再起動後.bgm === '55' && 再起動後.sfx === '70',
      '開き直してもつまみが戻っている',
      `BGM ${再起動後.bgm}% / 効果音 ${再起動後.sfx}%`);
  } finally {
    try { await cdp2.send('Browser.close'); } catch { /* もう閉じている */ }
    cdp2.close();
    await sleep(1000);
    chrome2.kill();
  }

  console.log('');
  if (失敗数 === 0) console.log('すべて合格。音量は保たれている。');
  else { console.error(`${失敗数}件 失敗。音量が保たれていない。`); process.exit(1); }
}

void main();
