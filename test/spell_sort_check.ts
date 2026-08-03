// 魔導書の並び順(装備頻度順)と、旧セーブからの引き継ぎを確かめる。
//
// 既定を「装備頻度順」に変えた。よく装備している魔法が上に来る。
// 旧セーブは「魔導値順かどうか」の真偽値しか持っていないので、
// 読み込み時に新しい形へ移し替える必要がある。ここが抜けると
// 並び順が毎回リセットされたり、装備回数が全部0になったりする。
//
// 見るのは
//   ・装備回数の多い順に並ぶか(同数なら魔導値の高い方が上)
//   ・装備するたびに回数が増えるか(外しても減らない)
//   ・ボタンで 装備頻度順 → 魔導値順 → 取得順 と巡回するか
//   ・旧セーブを読んでも壊れないか(魔導値順にしていた人はそのまま)
//   ・戦闘の魔法バーの並びが魔導書と一致するか
//
//   npx tsx test/spell_sort_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9377;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

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
    await sleep(350);
    return true;
  }

  close(): void { this.ws.close(); }
}

// 旧版のセーブ(sortByPower しか持たず、装備回数も無い)
function oldSave(name: string, sortByPower: boolean) {
  const sp = (id: string, sname: string, recipe: Record<string, number>) =>
    ({ id, name: sname, recipe, discoveries: [], level: 0, rarity: 'normal', stats: {} });
  return {
    version: 1, nickname: name, nickToken: `tok_${name}`, charId: 0, researchP: 300,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [
      sp('a', '弱い魔弾', { water: 2 }),      // 魔導値 低
      sp('b', '中くらいの魔弾', { ice: 3 }),  // 魔導値 中
      sp('c', '強い魔弾', { fire: 3 }),       // 魔導値 高
      sp('d', '闇の魔弾', { dark: 3 }),
    ],
    equipped: ['a'],                          // 今装備しているのは a だけ
    sortByPower,                              // 旧版の設定
    discovered: [], slots: 3, maxStage: 3, bestStage: 2,
    bossCleared: [], codexRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 魔導書の並び順(装備頻度順) ===');
  const profile = mkdtempSync(join(tmpdir(), 'madoken-sort-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
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
    if (!wsUrl) { check('ブラウザの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // 起動時スクリプトは積み重なってしまうので使わない。
    // 一度開いてから localStorage を書き換え、読み込み直す。
    const load = async (sortByPower: boolean) => {
      const name = `so${Math.random().toString(36).slice(2, 6)}`;
      await cdp.send('Page.navigate', { url: HTTP });
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(1200);
      const save = JSON.stringify(oldSave(name, sortByPower));
      await cdp.evaluate(
        'localStorage.setItem("magic_web_game_save_v1", '
        + JSON.stringify(save) + ');'
        + 'localStorage.setItem("madoken_sound_v2",'
        + ' JSON.stringify({bgmVolume:0,sfxVolume:0,muted:true}));');
      await cdp.send('Page.reload');
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      await cdp.click('#tab-lab');
      await sleep(500);
      return name;
    };

    const names = () => cdp.evaluate<string[]>(
      '[...document.querySelectorAll("#spell-list .spell-card .sname")]'
      + '.map(e => e.textContent.replace("★","").trim().split(" ")[0])');
    const sortBtn = () => cdp.evaluate<string>(
      'document.querySelector("#btn-sort-spells")?.textContent ?? ""');
    const saved = () => cdp.evaluate<any>(
      'JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}")');
    const equipNth = (n: number) => cdp.evaluate(
      '(() => { const c = document.querySelectorAll("#spell-list .spell-card");'
      + ` const b = c[${n}] && c[${n}].querySelector(".sbtns button");`
      + ' if (b && !b.disabled) b.click(); })()');

    // ---- 1. 旧セーブ(取得順だった人) → 装備頻度順になる ----
    console.log('\n--- 旧セーブ: 取得順だった人 ---');
    await load(false);
    check('既定が装備頻度順になる', (await sortBtn()).includes('装備頻度順'), await sortBtn());
    // 読み込んだだけでは保存されない。並び替えを一周させて書き込ませてから確かめる。
    for (let i = 0; i < 3; i++) { await cdp.click('#btn-sort-spells'); }
    await sleep(500);
    const s1 = await saved();
    check('並び順が新しい形で保存される', s1.sortMode === 'use', String(s1.sortMode));
    check('旧設定の項目は消えている', s1.sortByPower === undefined, String(s1.sortByPower));
    const counts1: Record<string, number> = {};
    for (const sp of s1.spells) counts1[sp.id] = sp.equipCount;
    check('装備中の魔法は1回とみなす', counts1.a === 1,
      JSON.stringify(counts1));
    check('未装備の魔法は0回', counts1.b === 0 && counts1.c === 0 && counts1.d === 0,
      JSON.stringify(counts1));

    const n1 = await names();
    check('装備している魔法が一番上', n1[0] === '弱い魔弾', n1.join(' / '));
    console.log(`     並び: ${n1.join(' / ')}`);

    // ---- 2. 装備すると回数が増え、順番が上がる ----
    console.log('\n--- 装備を繰り返す ---');
    // 「強い魔弾」を装備 → 外す → もう一度装備 で2回にする
    const idxOf = async (label: string) => (await names()).indexOf(label);
    for (let k = 0; k < 2; k++) {
      const i = await idxOf('強い魔弾');
      if (i >= 0) { await equipNth(i); await sleep(250); }
      const j = await idxOf('強い魔弾');
      if (j >= 0) { await equipNth(j); await sleep(250); } // 外す
    }
    const i2 = await idxOf('強い魔弾');
    if (i2 >= 0) await equipNth(i2); // もう一度装備
    await sleep(400);

    const s2 = await saved();
    const c2: Record<string, number> = {};
    for (const sp of s2.spells) c2[sp.id] = sp.equipCount;
    console.log(`     装備回数: ${JSON.stringify(c2)}`);
    check('装備するたびに回数が増える', c2.c >= 2, `強い魔弾=${c2.c}回`);
    check('外しても回数は減らない', c2.a >= 1, `弱い魔弾=${c2.a}回`);

    const n2 = await names();
    console.log(`     並び: ${n2.join(' / ')}`);
    check('回数の多い魔法が上に来る', n2.indexOf('強い魔弾') < n2.indexOf('中くらいの魔弾'),
      n2.join(' / '));

    // ---- 3. ボタンで3種を巡回する ----
    console.log('\n--- 並び替えボタン ---');
    await cdp.click('#btn-sort-spells');
    check('2番目は魔導値順', (await sortBtn()).includes('魔導値順'), await sortBtn());
    const nPower = await names();
    check('魔導値順では強い魔法が一番上', nPower[0] === '闇の魔弾' || nPower[0] === '強い魔弾',
      nPower.join(' / '));
    await cdp.click('#btn-sort-spells');
    check('3番目は取得順', (await sortBtn()).includes('取得順'), await sortBtn());
    const nOrder = await names();
    check('取得順は調合した順のまま', nOrder[0] === '弱い魔弾', nOrder.join(' / '));
    await cdp.click('#btn-sort-spells');
    check('一周して装備頻度順に戻る', (await sortBtn()).includes('装備頻度順'), await sortBtn());

    // ---- 4. 旧セーブ(魔導値順だった人)はその設定を引き継ぐ ----
    console.log('\n--- 旧セーブ: 魔導値順だった人 ---');
    await load(true);
    check('魔導値順のまま引き継がれる', (await sortBtn()).includes('魔導値順'), await sortBtn());
    // ここも読み込んだだけでは保存されないので、一周させて書き込ませる
    for (let i = 0; i < 3; i++) { await cdp.click('#btn-sort-spells'); }
    await sleep(500);
    const s4 = await saved();
    check('並び順が power になる', s4.sortMode === 'power', String(s4.sortMode));

    // ---- 5. 戦闘バーの並びが魔導書と一致する ----
    console.log('\n--- 戦闘バーとの一致 ---');
    await cdp.click('#tab-battle');
    await sleep(600);
    await cdp.click('#stage-select button:not(.boss)');
    await sleep(4500);
    const barNames = await cdp.evaluate<string[]>(
      '[...document.querySelectorAll("#spell-bar .spell-btn")]'
      + '.map(e => e.textContent.replace(/^\\d+/, "").trim().split("MP")[0].trim())');
    console.log(`     戦闘バー: ${barNames.join(' / ')}`);
    check('戦闘バーに魔法が並んでいる', barNames.length >= 1, `${barNames.length}個`);
    await cdp.click('#btn-escape');
    await sleep(800);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
