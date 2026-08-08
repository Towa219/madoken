// 交易所のガチャを確かめる。
//
// 見るのは
//   ・確率表が 100% になっているか(表と実装がずれていないか)
//   ・研究Pの当たりが確率どおりに出るか
//   ・同じ構成を持っていたら、増やさずに +1 強化になるか
//   ・引いた品質のほうが高ければ、品質も上がるか
//   ・すでに+9で品質も上がらない時は何も変わらないか
//   ・チケットが無いと引けないか
//   ・引くとチケットが1枚減り、当たった物(魔法か研究P)が実際に入るか
//     (GACHA_LIVE が false の「お試し」中は、何も動かないこと)
//   ・演出が出て、飛ばせて、結果が出るか
//   ・出た品質と結果の表示が一致しているか
//   ・演出の途中で閉じてもチケットの二重消費や取りこぼしが起きないか
//
// 品質は運任せなので、引いた結果をそのまま突き合わせる方式にしてある。
// 特定の品質を狙って出したい時だけ Math.random を差し替える。
//
//   npx tsx test/gacha_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENHANCE_MAX } from '../shared/spellcraft';
import { GACHA_LIVE, GACHA_PRIZES, rollGachaPrize } from '../shared/data';
import { gachaOutcomeFor } from '../shared/gacha';
import type { Spell } from '../shared/types';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9481;

const NAME = `gc${Math.random().toString(36).slice(2, 6)}`;

// ログインボーナスの「今日」と同じ形にする(src/daily.ts と同じ作り)
function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

function seedSave(tickets: number) {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    // 今日の分はもらった事にしておく。ログインボーナスで枚数が動くと
    // 「引いて1枚減った」のか「配られて1枚増えた」のか区別できない。
    // 日付そのものを入れること。'seeded' のような文字では今日と一致せず、
    // 開いた瞬間に1枚配られてしまう(実際にそれで数が合わなくなった)。
    bossRewarded: [], tickets, lastBonusDate: todayKey(),
  };
}

const snap = () => `
  (() => {
    const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1') || '{}');
    const fx = document.querySelector('#gacha-fx');
    const res = document.querySelector('#gacha-result');
    return {
      tickets: s.tickets, spells: (s.spells || []).length, rp: s.researchP,
      last: (s.spells || []).slice(-1)[0] || null,
      fxOpen: !!fx && !fx.classList.contains('hidden'),
      resultOpen: !!res && !res.classList.contains('hidden'),
      rarityText: document.querySelector('#gacha-result-rarity')?.textContent ?? '',
      nameText: document.querySelector('#gacha-result-name')?.textContent ?? '',
      drawDisabled: !!document.querySelector('#gacha-draw')?.disabled,
      shown: document.querySelector('#ticket-display')?.textContent ?? '',
    };
  })()
`;

interface Snap {
  tickets: number; spells: number; rp: number;
  last: { rarity: string; name: string; level: number } | null;
  fxOpen: boolean; resultOpen: boolean; rarityText: string; nameText: string;
  drawDisabled: boolean; shown: string;
}

const RARITY_JA: Record<string, string> = {
  normal: '通常', rare: 'レア', epic: 'エピック', legend: 'レジェンド',
};

async function main(): Promise<void> {
  console.log('=== 交易所のガチャ ===');
  console.log(`対象: ${HTTP}`);

  // ---- 0. 確率表(ブラウザを立ち上げずに確かめられる分) ----
  const sum = GACHA_PRIZES.reduce((a, p) => a + p.pct, 0);
  // 0.1% のような小数が入るので、ぴったり100とは限らない
  // (0.1+1+5+20+30+43.9 は浮動小数だと 100.00000000000001 になる)。
  check('★確率の合計が100%', Math.abs(sum - 100) < 1e-9, `${sum}%`);

  // 賞品を一言で表す(境目の突き合わせ用)
  const tag = (r: number): string => {
    const p = rollGachaPrize(r);
    return p.kind === 'rp' ? `rp${p.amount}` : p.rarity;
  };
  // 累計は 0.1 / 1.1 / 6.1 / 26.1 / 56.1 / 100(%)。境目の前後を1つずつ見る
  const edge: [number, string][] = [
    [0, 'legend'], [0.0009, 'legend'],
    [0.0011, 'epic'], [0.0109, 'epic'],
    [0.0111, 'rare'], [0.0609, 'rare'],
    [0.0611, 'normal'], [0.2609, 'normal'],
    [0.2611, 'rp200'], [0.5609, 'rp200'],
    [0.5611, 'rp100'], [0.9999, 'rp100'],
  ];
  const bad = edge.filter(([r, want]) => tag(r) !== want);
  check('★確率の境目が表のとおり', bad.length === 0,
    bad.map(([r, w]) => `${r}は${w}のはず(実際は${tag(r)})`).join(' / '));

  // ---- 0b. 重複した時の扱い(ブラウザ不要) ----
  const mk = (level: number, rarity: string): Spell => ({
    id: 'x', name: 'テスト', recipe: { fire: 2, wind: 1 }, stats: {} as never,
    discoveries: [], level, equipCount: 0, rarity: rarity as never,
  });
  const same = { fire: 2, wind: 1 };
  const other = { fire: 3 };

  const P = (rarity: string) =>
    ({ kind: 'spell', rarity, pct: 1 }) as never;

  const rp = gachaOutcomeFor([], same, { kind: 'rp', amount: 200, pct: 30 });
  check('★研究Pの当たりは持ち物を見ない',
    rp.kind === 'rp' && rp.amount === 200, `${rp.kind}`);

  const nw = gachaOutcomeFor([mk(0, 'normal')], other, P('normal'));
  check('★持っていない構成なら新しく1本', nw.kind === 'new', nw.kind);

  const en = gachaOutcomeFor([mk(2, 'normal')], same, P('normal'));
  check('★同じ構成なら増やさずに+1', en.kind === 'enhance'
    && en.level === 3, `${en.kind} / +${(en as { level?: number }).level}`);

  const up = gachaOutcomeFor([mk(2, 'normal')], same, P('legend'));
  check('★引いた品質が上なら品質も上がる',
    up.kind === 'enhance' && up.rarityUp === true && up.level === 3,
    `${up.kind} / 品質上昇=${(up as { rarityUp?: boolean }).rarityUp}`);

  const down = gachaOutcomeFor([mk(2, 'legend')], same, P('normal'));
  check('★引いた品質が下なら品質は据え置き',
    down.kind === 'enhance' && down.rarityUp === false,
    `品質上昇=${(down as { rarityUp?: boolean }).rarityUp}`);

  const cap = gachaOutcomeFor([mk(ENHANCE_MAX, 'legend')], same, P('normal'));
  check(`★+${ENHANCE_MAX}で品質も上がらないなら何も変わらない`,
    cap.kind === 'max', cap.kind);

  const capUp = gachaOutcomeFor([mk(ENHANCE_MAX, 'normal')], same, P('legend'));
  check(`★+${ENHANCE_MAX}でも品質が上がるなら反映する`,
    capUp.kind === 'enhance' && capUp.level === ENHANCE_MAX,
    `${capUp.kind} / +${(capUp as { level?: number }).level}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-gc-'));
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

    let seeded: any = null;
    const openWith = async (tickets: number) => {
      if (seeded) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
          { identifier: seeded.result?.identifier });
      }
      seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(tickets)))});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}`,
      });
      await cdp.send('Page.navigate', { url: HTTP });
      // about:blank も readyState は complete なので、行き先が変わるのも待つ
      for (let i = 0; i < 60; i++) {
        const here = await cdp.evaluate<string>('location.href');
        if (here && !here.startsWith('about:')
          && await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(2500);
      await cdp.evaluate('document.querySelector("#tab-shop").click()');
      await sleep(600);
    };

    // ---- 1. 交易所が開けて、確率表が出る ----
    await openWith(2);
    const opened = await cdp.evaluate<boolean>(
      '!document.querySelector("#shop-screen").classList.contains("hidden")');
    check('★交易所のタブが開く', opened);
    const odds = await cdp.evaluate<number>(
      'document.querySelectorAll("#gacha-odds .gacha-odd").length');
    check('確率表が出ている', odds === GACHA_PRIZES.length, `${odds}件`);

    // 残念賞(いちばん出る受け皿)は、確率を出さずに名前だけ見せる。
    // 当たりの数字だけを並べたいので、ここに % が戻ったら気づけるようにする。
    const oddsText = await cdp.evaluate<string>(
      'document.getElementById("gacha-odds").innerText');
    const consolation = GACHA_PRIZES.find(p => p.consolation);
    check('★残念賞として出ている', oddsText.includes('残念賞'),
      oddsText.split('\n').join(' / '));
    check('★残念賞の確率は出していない',
      consolation !== undefined && !oddsText.includes(`${consolation.pct}%`),
      consolation ? `${consolation.pct}% が出ていないこと` : '残念賞の行が無い');

    // ---- 2. 引くとチケットが減り、魔法が増える ----
    const before = await cdp.evaluate<Snap>(snap());
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(400);
    const during = await cdp.evaluate<Snap>(snap());
    check('★演出が出る', during.fxOpen);
    check('演出中は結果を見せない', !during.resultOpen);
    check(GACHA_LIVE ? '★引いた直後にチケットが減る'
      : '★お試し中はチケットが減らない',
    during.tickets === before.tickets - (GACHA_LIVE ? 1 : 0),
    `${before.tickets}→${during.tickets}枚`);

    // 演出を飛ばす(実際の操作と同じく、覆いを押す)
    for (let i = 0; i < 6; i++) {
      await cdp.evaluate('document.querySelector("#gacha-fx").click()');
      await sleep(120);
    }
    await sleep(900);
    const after = await cdp.evaluate<Snap>(snap());
    check('★演出を飛ばすと結果が出る', after.resultOpen);
    check('結果カードに当たりの種類が出る',
      [...Object.values(RARITY_JA), '研究P']
        .some(v => after.rarityText.includes(v)), after.rarityText);
    check('結果カードに中身が出る', after.nameText.length > 0, after.nameText);

    // 何が当たるかは運任せなので、出た内容とセーブの変化を突き合わせる
    const gotRp = after.rarityText.includes('研究P');
    if (!GACHA_LIVE) {
      check('★お試し中は魔法が増えない', after.spells === before.spells,
        `${before.spells}→${after.spells}本`);
      check('★お試し中は研究Pも増えない', after.rp === before.rp,
        `${before.rp}→${after.rp}`);
    } else if (gotRp) {
      const amount = Number(/\+(\d+)/.exec(after.nameText)?.[1] ?? 0);
      check('★研究Pが表示どおり増える', amount > 0 && after.rp === before.rp + amount,
        `${before.rp}→${after.rp}(表示 +${amount})`);
      check('研究Pの回は魔法が増えない', after.spells === before.spells,
        `${before.spells}→${after.spells}本`);
    } else {
      check('★魔法が1本増える', after.spells === before.spells + 1,
        `${before.spells}→${after.spells}本`);
      check('★出た品質と表示が一致する',
        !!after.last && after.rarityText.includes(RARITY_JA[after.last.rarity]),
        `保存=${after.last?.rarity} 表示=${after.rarityText}`);
      check('★出た魔法と表示が一致する',
        !!after.last && after.nameText === after.last.name,
        `保存=${after.last?.name} 表示=${after.nameText}`);
    }
    check('上のバーの枚数がセーブと一致する',
      after.shown.includes(String(after.tickets)), after.shown);

    // ---- 3. 結果を閉じても取りこぼさない ----
    await cdp.evaluate('document.querySelector("#gacha-close").click()');
    await sleep(300);
    const closed = await cdp.evaluate<Snap>(snap());
    check('結果を閉じると演出も消える', !closed.fxOpen);
    check('閉じても持ち物は変わらない', closed.spells === after.spells
      && closed.rp === after.rp, `${closed.spells}本 / 研究P${closed.rp}`);

    // ---- 4. チケットが尽きたら引けない ----
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(400);
    for (let i = 0; i < 8; i++) {
      await cdp.evaluate('document.querySelector("#gacha-fx").click()');
      await sleep(120);
    }
    await sleep(700);
    await cdp.evaluate('document.querySelector("#gacha-close").click()');
    await sleep(300);
    const empty = await cdp.evaluate<Snap>(snap());
    check(GACHA_LIVE ? '★2回引くとチケットが0になる'
      : '★お試し中は2回引いてもチケットが残る',
    empty.tickets === (GACHA_LIVE ? 0 : 2), `${empty.tickets}枚`);
    check(GACHA_LIVE ? '★0枚では引くボタンが押せない'
      : '★お試し中は0枚でも押せる', empty.drawDisabled === GACHA_LIVE);

    // 押しても増えないことまで見る(ボタンの見た目だけの無効化を防ぐ)
    await cdp.evaluate('document.querySelector("#gacha-draw").click()');
    await sleep(600);
    const stuck = await cdp.evaluate<Snap>(snap());
    check('★もう一度押しても何も増えない',
      stuck.spells === empty.spells && stuck.rp === empty.rp,
      `${empty.spells}→${stuck.spells}本 / 研究P${empty.rp}→${stuck.rp}`);
    check('チケットが負にならない', stuck.tickets >= 0, `${stuck.tickets}枚`);

    // ---- 5. 魔法が当たる経路(乱数を固定して必ず出す) ----
    // 何が出るかは運任せなので、上の手順では研究Pばかりの回もある。
    // レジェンドを狙い撃ちして、受け取りと重複の扱いまで見る。
    if (GACHA_LIVE) {
      await openWith(5);
      // 0 を返すと必ず先頭の当たり(レジェンド)になる。
      // 構成の抽選も同じ乱数を使うので、系統は毎回同じものが選ばれる。
      await cdp.evaluate('Math.random = () => 0');
      const base = await cdp.evaluate<Snap>(snap());

      const drawOnce = async () => {
        await cdp.evaluate('document.querySelector("#gacha-draw").click()');
        for (let i = 0; i < 8; i++) {
          await cdp.evaluate('document.querySelector("#gacha-fx").click()');
          await sleep(120);
        }
        await sleep(800);
        const got = await cdp.evaluate<Snap>(snap());
        await cdp.evaluate('document.querySelector("#gacha-close").click()');
        await sleep(300);
        return got;
      };

      const first = await drawOnce();
      check('★レジェンドを引くと魔法が1本増える', first.spells === base.spells + 1,
        `${base.spells}→${first.spells}本`);
      check('★受け取った魔法がレジェンドになっている',
        first.last?.rarity === 'legend', String(first.last?.rarity));
      check('レジェンドと表示されている', first.rarityText.includes('レジェンド'),
        first.rarityText);

      const second = await drawOnce();
      check('★同じものをもう一度引いても本数は増えない',
        second.spells === first.spells, `${first.spells}→${second.spells}本`);
      check('★代わりに +1 強化される', second.last?.level === 1,
        `+${second.last?.level}`);
      check('結果カードに「重複 → 強化」と出る',
        second.rarityText.includes('重複'), second.rarityText);
      check('チケットは2枚使われている', second.tickets === base.tickets - 2,
        `${base.tickets}→${second.tickets}枚`);
    }
  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });
