// 「戦闘」と「オンライン」を1つのタブにまとめた後の画面を確かめる。
//
// 見るのは
//   ・上のメニューが「戦闘」だけになり、「オンライン」が消えているか
//   ・「戦闘」の右に「ショップ」があり、押せない状態か(未実装)
//   ・戦闘タブに、出撃準備とオンラインの両方が出ているか
//   ・ステージを選んでも、すぐには始まらないか(選ぶ=挑むではない)
//   ・選んだステージが、ソロと共闘部屋の両方に使われるか
//   ・ボスのステージはソロで出撃できないか(共闘部屋からのみ)
//   ・「装備中の魔法」の一覧が消えているか
//   ・ソロ戦闘を始めると、下に並んでいるロビーが隠れるか
//
//   npx tsx test/battle_tab_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9473;

const NAME = `bt${Math.random().toString(36).slice(2, 6)}`;

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

  close(): void { this.ws.close(); }
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    // ボス(5)まで行ける状態にしておく
    discovered: [], slots: 4, maxStage: 6, bestStage: 5,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// 見えているか(hidden が付いていない & 実際に大きさがある)
const visible = (sel: string) => `
  (() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()
`;

// そのステージのボタンを押す。
//
// 押すとボタン列は作り直されるので、押した要素をそのまま見てはいけない
// (作り直しで捨てられた古い要素には印が付かない)。引き直して確かめる。
const pickStage = (n: number) => `
  (() => {
    const find = () => [...document.querySelectorAll('#stage-select button')]
      .find(x => parseInt(x.textContent, 10) === ${n});
    const b = find();
    if (!b) return false;
    b.click();
    return !!find()?.classList.contains('selected');
  })()
`;

async function main(): Promise<void> {
  console.log('=== 戦闘タブ(オンラインと合併)とショップ ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bt-'));
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

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);

    // ---- 1. 上のメニュー ----
    const tabs = await cdp.evaluate<{ id: string; text: string; disabled: boolean }[]>(`
      [...document.querySelectorAll('#topbar nav button')]
        .map(b => ({ id: b.id, text: b.textContent.trim(), disabled: b.disabled }))
    `);
    console.log(`     並び: ${tabs.map(t => t.text).join(' / ')}`);
    check('★「オンライン」が無くなっている', !tabs.some(t => t.id === 'tab-online'));
    check('「戦闘」がある', tabs.some(t => t.id === 'tab-battle'));

    const iBattle = tabs.findIndex(t => t.id === 'tab-battle');
    const iShop = tabs.findIndex(t => t.id === 'tab-shop');
    check('★「ショップ」がある', iShop >= 0);
    check('★「ショップ」は戦闘のすぐ右', iShop === iBattle + 1,
      `戦闘=${iBattle} / ショップ=${iShop}`);
    check('★「ショップ」は押せない(未実装)', tabs[iShop]?.disabled === true);

    // 押しても何も起きない(画面が切り替わらない)
    await cdp.evaluate("document.querySelector('#tab-shop').click()");
    await sleep(500);
    check('押しても画面が変わらない',
      await cdp.evaluate<boolean>(visible('#lab-screen')), '研究室のまま');

    // ---- 2. 戦闘タブに両方が出ている ----
    await cdp.evaluate("document.querySelector('#tab-battle').click()");
    await sleep(1500);
    check('出撃準備が出ている', await cdp.evaluate<boolean>(visible('#battle-setup')));
    const online = await cdp.evaluate<boolean>(
      `${visible('#online-login')} || ${visible('#online-lobby')}`);
    check('★同じ画面にオンラインも出ている', online);

    // ---- 3. 「装備中の魔法」は消えている ----
    check('★「装備中の魔法」の一覧が無い',
      !(await cdp.evaluate<boolean>('!!document.querySelector("#equip-summary")')));

    // ---- 4. ステージを選んでもすぐには始まらない ----
    check('ステージ3を選べた', await cdp.evaluate<boolean>(pickStage(3)));
    await sleep(600);
    check('★選んだだけでは戦闘が始まらない',
      !(await cdp.evaluate<boolean>(visible('#battle-view'))));
    const soloLabel = await cdp.evaluate<string>(
      'document.querySelector("#btn-solo-go").textContent');
    const roomLabel = await cdp.evaluate<string>(
      'document.querySelector("#btn-create-room").textContent');
    check('★ソロのボタンに選んだステージが出る', soloLabel.includes('3'), soloLabel);
    check('★共闘部屋のボタンにも同じステージが出る', roomLabel.includes('3'), roomLabel);

    // ---- 5. ボスはソロで挑めない ----
    check('ステージ5(ボス)を選べた', await cdp.evaluate<boolean>(pickStage(5)));
    await sleep(600);
    check('★ボスではソロで出撃できない',
      await cdp.evaluate<boolean>('document.querySelector("#btn-solo-go").disabled'));
    check('★ボスでも共闘部屋は作れる',
      !(await cdp.evaluate<boolean>('document.querySelector("#btn-create-room").disabled')));
    const msg = await cdp.evaluate<string>(
      'document.querySelector("#setup-msg").textContent');
    check('理由が書いてある', msg.includes('共闘'), msg);

    // ---- 6. ソロ戦闘を始めるとロビーが隠れる ----
    check('ステージ3を選び直せた', await cdp.evaluate<boolean>(pickStage(3)));
    await sleep(400);
    await cdp.evaluate("document.querySelector('#btn-solo-go').click()");
    await sleep(2000);
    check('★ソロ戦闘が始まった', await cdp.evaluate<boolean>(visible('#battle-view')));
    check('★戦闘中はロビーが隠れる',
      !(await cdp.evaluate<boolean>(
        `${visible('#online-login')} || ${visible('#online-lobby')}`)));
    check('戦闘中は出撃準備も隠れる',
      !(await cdp.evaluate<boolean>(visible('#battle-setup'))));
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: `tok_${NAME}` }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
