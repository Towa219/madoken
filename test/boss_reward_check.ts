// 最深部の報酬(深いボスの討伐で上位品質の魔法が1つ贈られる)を確かめる。
//
//   ステージ30 … レア
//   ステージ40 … エピック
//   ステージ50 … レジェンド
//
// どれも通常の調合では滅多に出ない品質なので、深く潜った証として確実に渡す。
// 同じステージから2本目は出ない。
//
// 実際にステージ50まで進めるには時間がかかるので、報酬を渡す処理そのものを
// ブラウザ上で呼んで確かめる。「ボスを倒したら呼ばれるか」は coop.ts の
// stageclear から grantBossReward(m.stage) を呼ぶ1行で、目視で追える。
//
//   npx tsx test/boss_reward_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOSS_REWARDS, LEGEND_BOSS_STAGE, RARITIES } from '../shared/data';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9393;

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
    await sleep(400);
    return true;
  }

  close(): void { this.ws.close(); }
}

const NAME = `br${Math.random().toString(36).slice(2, 6)}`;

// legendOld を true にすると、報酬を作り直す前のセーブ(ステージ50を
// 受領済みの人)を再現できる。作り直しでもう一度貰えてしまわないかを見る。
function seedSave(legendOld = false) {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 500,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [], equipped: [],
    // 図鑑は未完成にしておく(図鑑報酬と取り違えないため)
    discovered: [], slots: 5, maxStage: 50, bestStage: 49,
    bossCleared: [], sortMode: 'use', codexRewarded: false,
    legendRewarded: legendOld,
  };
}

const grant = (stage: number) =>
  `(window.__madokenGrantBoss && window.__madokenGrantBoss(${stage}))`;

async function main(): Promise<void> {
  console.log('=== 最深部の報酬(ステージ30/40/50) ===');
  console.log(`対象: ${HTTP}`);
  console.log(`  ${BOSS_REWARDS.map(r => `${r.stage}→${RARITIES[r.rarity].name}`).join(' / ')}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-br-'));
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

    let seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    const open = async () => {
      await cdp.send('Page.navigate', { url: HTTP });
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(3000);
    };
    await open();

    const spells = () => cdp.evaluate<{ name: string; rarity: string }[]>(
      '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").spells || [])'
      + '.map(s => ({ name: s.name, rarity: s.rarity }))');
    const got = () => cdp.evaluate<number[]>(
      '(JSON.parse(localStorage.getItem("magic_web_game_save_v1") || "{}").bossRewarded || [])');

    // 決めごとをそのまま書いておく。
    // 以下の確認は BOSS_REWARDS を回して作るので、表から行が消えても
    // 「その行の確認が実行されなくなる」だけで気づけない。ここで釘を刺す。
    const has = (stage: number, rarity: string) =>
      BOSS_REWARDS.some(r => r.stage === stage && r.rarity === rarity);
    check('★ステージ30の報酬はレア', has(30, 'rare'));
    check('★ステージ40の報酬はエピック', has(40, 'epic'));
    check('★ステージ50の報酬はレジェンド', has(LEGEND_BOSS_STAGE, 'legend'));

    check('最初は魔法を持っていない', (await spells()).length === 0);
    check('最初は受領なし', (await got()).length === 0);

    // ---- 図鑑に3つとも案内が出ているか ----
    await cdp.click('#tab-book');
    await sleep(800);
    const notice = await cdp.evaluate<string>('document.body.innerText');
    for (const r of BOSS_REWARDS) {
      check(`図鑑にステージ${r.stage}の${RARITIES[r.rarity].name}が案内されている`,
        notice.includes(`ステージ${r.stage}`) && notice.includes(RARITIES[r.rarity].name));
    }

    check('報酬の処理を呼べる口がある',
      await cdp.evaluate<boolean>("typeof window.__madokenGrantBoss === 'function'"));

    // ---- 報酬のないステージでは何も起きない ----
    await cdp.evaluate(grant(25));
    await sleep(500);
    check('★報酬のないボス(25)では何ももらえない', (await spells()).length === 0,
      `${(await spells()).length}本`);

    // ---- 3つとも順に受け取る ----
    let expect = 0;
    for (const r of BOSS_REWARDS) {
      await cdp.evaluate(grant(r.stage));
      await sleep(600);
      expect++;
      const list = await spells();
      const last = list[list.length - 1];
      check(`★ステージ${r.stage}で1つ増えた`, list.length === expect, `${list.length}本`);
      check(`品質が${RARITIES[r.rarity].name}`, last?.rarity === r.rarity,
        String(last?.rarity));
      // カタカナの真名が付くのはエピックとレジェンドだけ。
      // レアは通常の和名のまま(shared/spellcraft.ts の trueName)。
      if (r.rarity === 'rare') {
        check('レアは通常の和名', !!last?.name, last?.name ?? '');
      } else {
        check('カタカナの真名になっている', /[ァ-ヴー]/.test(last?.name ?? ''),
          last?.name ?? '');
      }
      console.log(`     授かった魔法: ${last?.name}`);

      // 同じステージを何度倒しても増えない
      for (let i = 0; i < 3; i++) { await cdp.evaluate(grant(r.stage)); await sleep(200); }
      check(`★ステージ${r.stage}は何度倒しても2本目が出ない`,
        (await spells()).length === expect, `${(await spells()).length}本`);
    }
    check('受領済みが3件になっている', (await got()).length === BOSS_REWARDS.length,
      (await got()).join('・'));

    await cdp.click('#tab-lab');
    await sleep(400);
    await cdp.click('#tab-book');
    await sleep(800);
    const notice2 = await cdp.evaluate<string>('document.body.innerText');
    check('図鑑の案内が「討伐済み」に変わる',
      (notice2.match(/討伐済み/g) ?? []).length === BOSS_REWARDS.length,
      `${(notice2.match(/討伐済み/g) ?? []).length}件`);

    // ---- 作り直す前のセーブから引き継げるか ----
    //
    // 以前はステージ50の受領だけを真偽値で持っていた。引き継ぎ損ねると、
    // 受け取り済みの人がレジェンドをもう1本もらえてしまう。
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
      { identifier: seeded.result?.identifier });
    seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1',
          ${JSON.stringify(JSON.stringify(seedSave(true)))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await open();
    // 引き継ぎは読み込み時に行われるが、保存されるまで localStorage は古いまま。
    // 何か1つ受け取らせて書き込ませてから、中身を確かめる。
    await cdp.evaluate(grant(LEGEND_BOSS_STAGE));
    await sleep(600);
    check('★受け取り済みの人にレジェンドが再配布されない',
      (await spells()).length === 0, `${(await spells()).length}本`);

    await cdp.evaluate(grant(BOSS_REWARDS[0].stage));
    await sleep(600);
    const carried = await got();
    check(`古いセーブから受領済みが引き継がれている(${LEGEND_BOSS_STAGE})`,
      carried.includes(LEGEND_BOSS_STAGE), carried.join('・'));
    check('その人も未受領のステージは受け取れる',
      (await spells()).length === 1, `${(await spells()).length}本`);
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
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
