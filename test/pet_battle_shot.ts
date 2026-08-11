// 共闘の画面で、連れているペットがキャラの上に出るかを目で確かめる。
//
//   npx tsx test/pet_battle_shot.ts
//
// ★ 鳥は PixiJS が canvas へ描くので、DOM を調べても出てこない。
//   絵を撮って人が見るしかない。数字で測れるのは「サーバーが
//   petSpecies を配ったか」までなので、そこは別に確かめる。
//
// ペットの用意は画面を操作せず、通信を直接叩いて済ませる。
// 孵化の演出を待つと1羽あたり6秒近くかかるうえ、演出の検証は
// test/hatch_shot.ts が別に受け持っている。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTTP = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const PORT = 9491;
const OUT = join(process.cwd(), 'tools', 'shots');
const NAME = `pb${Math.random().toString(36).slice(2, 6)}`;
// 撮りたい鳥。指定しなければボスの池から出た1羽になる。
const 種 = process.env.PET_SPECIES ?? '';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 2, earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 50, bestStage: 50,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 共闘でペットが出るか撮る ===');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'madoken-pb-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1000,760', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
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
    if (!wsUrl) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const ws = new WebSocket(wsUrl);
    await new Promise<void>(r => { ws.onopen = () => r(); });
    let id = 0;
    const waiting = new Map<number, (v: any) => void>();
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; waiting.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;
    const shot = async (name: string): Promise<void> => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (!r.result?.data) { console.log(`  (${name} は撮れなかった)`); return; }
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
      console.log(`  撮影: tools/shots/${name}.png`);
    };

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
    await send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await ev<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4500);

    // 管理者モードに入れているか(合言葉は sessionStorage へ先に置いてある)
    const 管理者 = await ev<boolean>(
      '!document.querySelector("#tab-pet").classList.contains("hidden")');
    if (!管理者) { console.log('  NG  管理者モードに入れていない'); ng++; }
    else console.log('  OK  管理者モードで「ペット」タブが出ている');

    // ペットを1羽そろえる。通信を直接叩く(画面操作より速くて確実)。
    const 用意 = await ev<string>(`(async () => {
      const key = ${JSON.stringify(KEY)}, name = ${JSON.stringify(NAME)};
      const call = async (path, extra) => {
        const r = await fetch('/api/pet/' + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, name, ...extra }),
        });
        return { 状態: r.status, データ: await r.json() };
      };
      const 欲しい = ${JSON.stringify(種)};
      let pet = null;
      for (let 試行 = 0; 試行 < 40; 試行++) {
        const 発行 = await call('grant', { stage: 30 });
        if (発行.状態 !== 200) return '卵を出せない: ' + JSON.stringify(発行.データ);
        const 卵 = 発行.データ.pet;
        if (!欲しい) { pet = 卵; break; }
        // 卵のうちは種類が伏せられているので、孵してから確かめる
        let 今 = 卵;
        for (let i = 0; i < 6; i++) {
          await call('advance', { days: 1 });
          const w = await call('warm', { petId: 今.id });
          if (w.状態 !== 200) return '温められない: ' + JSON.stringify(w.データ);
          今 = w.データ.pet;
          if (w.データ.hatched) break;
        }
        if (今.species === 欲しい) { pet = 今; break; }
        await call('release', { petId: 今.id });
      }
      if (!pet) return '欲しい鳥が出なかった: ' + 欲しい;
      while (!pet.species) {
        await call('advance', { days: 1 });
        const w = await call('warm', { petId: pet.id });
        if (w.状態 !== 200) return '温められない: ' + JSON.stringify(w.データ);
        pet = w.データ.pet;
      }
      // 雛のままだと効果が半分なので、成鳥まで進める
      await call('advance', { days: 8 });
      const c = await call('choose', { petId: pet.id });
      if (c.状態 !== 200) return '連れて行けない: ' + JSON.stringify(c.データ);
      return 'OK:' + pet.species + ':' + pet.name;
    })()`);
    if (!用意.startsWith('OK')) { console.log(`  NG  ペットを用意できない → ${用意}`); ng++; }
    else console.log(`  OK  ペットを用意した → ${用意.slice(3)}`);

    // 一度ペット画面を開く(遊ぶ人と同じ順序)。
    // ここで一覧を取り直すので、単騎戦闘へ渡す控えも埋まる。
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(1800);

    // 共闘のボス面へ
    await ev('document.querySelector("#tab-battle").click()');
    await sleep(900);
    const 選択 = await ev<string>(`(() => {
      const bs = [...document.querySelectorAll('#stage-select button')];
      const b = bs.find(x => (x.textContent || '').trim().split(' ')[0] === '20');
      if (!b) return 'ステージ20のボタンが無い(数=' + bs.length + ')';
      b.click(); return 'OK';
    })()`);
    if (選択 !== 'OK') { console.log(`  NG  ${選択}`); ng++; }
    await sleep(600);
    await ev("document.querySelector('#btn-create-room').click()");
    await sleep(3500);
    // ★ ボタンの文言は「準備完了!」。「開始|出撃」だけで探すと当たらず、
    //   出撃準備の画面のまま撮ってしまう(実際にそうなった)。
    // ★ 画面に出ているボタンだけを対象にすること。
    //   文字だけで探すと、隠れている同名のボタンを先に押してしまい、
    //   「押せた」と言いながら何も起きない(実際にそうなった)。
    const 開始 = await ev<string>(`(() => {
      const b = [...document.querySelectorAll('button')]
        .filter(x => !x.disabled && x.offsetParent !== null)
        .find(x => /準備完了|開始|はじめ|スタート|出撃/.test(x.textContent || ''));
      if (!b) return '押せるボタンが無い';
      b.click(); return 'OK:' + b.textContent.trim();
    })()`);
    console.log(`  開始ボタン: ${開始}`);
    if (!開始.startsWith('OK')) ng++;
    await sleep(3000);
    // 押しただけでは始まらないことがある。何が起きているか見てから待つ。
    const 様子 = await ev<string>(`(() => {
      const panel = [...document.querySelectorAll('div,section')]
        .find(d => /出撃準備/.test(d.textContent || '') && d.children.length < 12);
      const 見える = panel && !panel.closest('.hidden')
        && getComputedStyle(panel).display !== 'none';
      const bs = [...document.querySelectorAll('button')]
        .filter(b => !b.disabled && b.offsetParent !== null)
        .map(b => (b.textContent || '').trim()).filter(Boolean);
      return JSON.stringify({ 準備画面: Boolean(見える), 押せるボタン: bs.slice(0, 8) });
    })()`);
    console.log(`  3秒後の様子: ${様子}`);
    await sleep(5000);   // 3→2→1 の合図を待つ

    // サーバーが鳥の種類を配っているか(ここは数字で確かめられる)
    const 配布 = await ev<string>(`(() => {
      const c = document.querySelector('canvas');
      return c ? c.width + 'x' + c.height : 'canvasが無い';
    })()`);
    console.log(`  戦闘の画面: ${配布}`);

    await shot(`pet_battle_共闘${種 ? '_' + 種 : ''}`);

    // ★ 通常ステージ(単騎)でも必ず撮ること。
    //   共闘だけを撮っていたせいで「単騎には一切入っていない」ことに
    //   気づけず、遊ぶ人に先に見つけられた(2026-08-11)。
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')]
        .filter(x => !x.disabled && x.offsetParent !== null)
        .find(x => /退出|抜け|やめ|閉じ|戻/.test(x.textContent || ''));
      if (b) b.click();
    })()`);
    await sleep(3000);
    await ev('document.querySelector("#tab-battle").click()');
    await sleep(900);
    const 通常 = await ev<string>(`(() => {
      const bs = [...document.querySelectorAll('#stage-select button')];
      const b = bs.find(x => (x.textContent || '').trim().split(' ')[0] === '3');
      if (!b) return 'ステージ3のボタンが無い(数=' + bs.length + ')';
      b.click(); return 'OK';
    })()`);
    if (通常 !== 'OK') { console.log(`  NG  ${通常}`); ng++; }
    await sleep(700);
    const 出撃 = await ev<string>(`(() => {
      const b = [...document.querySelectorAll('button')]
        .filter(x => !x.disabled && x.offsetParent !== null)
        .find(x => /出撃|開始|はじめ|スタート|挑/.test(x.textContent || ''));
      if (!b) return '押せるボタンが無い';
      b.click(); return 'OK:' + b.textContent.trim();
    })()`);
    console.log(`  単騎の開始ボタン: ${出撃}`);
    if (!出撃.startsWith('OK')) ng++;
    await sleep(6500);
    await shot(`pet_battle_単騎${種 ? '_' + 種 : ''}`);
    console.log('  ※ 共闘と単騎の両方で、頭の上に鳥が出ているか絵を見ること');

    ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(ng === 0 ? '=== 手順は通った ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();
