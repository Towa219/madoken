// ショップのガチャ(魔導の抽選)
//
// チケット1枚で魔法を1本引く。品質は GACHA_ODDS の確率で決め、
// 系統は運任せ。その系統が成立する構成のうち最も魔導値が高いものを作る
// (最深部の報酬 grantBossReward と同じ作り方に揃えてある)。
//
// 演出は Pixi ではなく CSS で組んでいる。戦闘の Pixi は戦闘画面でしか
// 動いておらず、この3秒のために2つ目のレンダラを起こすと、
// 開くたびに GPU の確保が走って重い。回転・拡大・発光は CSS の方が素直。

import {
  GACHA_COST, GACHA_ODDS, RARITIES, rollGachaRarity,
} from '../shared/data';
import {
  computeSpell, finalStats, randomComposition, spellMagicValue, spellNameFor,
} from '../shared/spellcraft';
import { addSpell, notify, save, state } from './state';
import { showToast } from './lab';
import { playBgm, playSfx } from './sound';
import type { Rarity, Spell } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// 品質ごとの光の色。予告の柱にこの色を使い、出る前に期待させる。
// 通常だけは白のままにして、色が付いた時点で「当たり」と分かるようにする。
const PILLAR: Record<Rarity, string> = {
  normal: '#ddddee',
  rare: '#66aaff',
  epic: '#cc77ff',
  legend: '#ffcc44',
};

// 演出の進み方(秒)。合計 2.9 秒。
// 長いと2回目から飛ばしたくなるので、押してから結果まで3秒以内に収める。
const T_CHARGE = 1.5;   // 魔法陣が回り出して力が溜まる
const T_PILLAR = 0.8;   // 品質の色で予告する
const T_OPEN = 0.6;     // 弾けて結果が出る

let running = false;
let skip: (() => void) | null = null;

// ===== 抽選 =====

// 引いた品質で魔法を1本こしらえる。まだ持ち物には入れない。
function makeSpell(rarity: Rarity): Spell | null {
  // 素材の数は今の調合スロットに合わせる(最深部の報酬と同じ扱い)。
  // 系統を1つ選ぶだけでは、素材が足りない系統を引いた時に何も出ない。
  const picked = randomComposition(Math.max(3, state.slots));
  if (!picked) return null;
  const counts = picked.counts;
  const { matched } = computeSpell(counts);
  return {
    id: `sp_gacha_${Date.now()}`,
    name: spellNameFor(counts, rarity),
    recipe: counts,
    stats: finalStats(counts, 0, rarity),
    discoveries: matched.map(r => r.id),
    level: 0,
    equipCount: 0,
    rarity,
  };
}

// ===== 演出 =====

// 途中で押されたら結果まで飛ばす。2回目以降は毎回見たいものではない。
function racedSleep(ms: number): Promise<void> {
  return new Promise<void>(res => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      if (skip === done) skip = null;
      res();
    }
    skip = done;
  });
}

async function runFx(rarity: Rarity): Promise<void> {
  const fx = $('#gacha-fx');
  const outer = $('#gacha-circle-outer');
  const inner = $('#gacha-circle-inner');
  const pillar = $('#gacha-pillar');
  const flash = $('#gacha-flash');
  const result = $('#gacha-result');

  result.classList.add('hidden');
  fx.classList.remove('hidden');
  fx.setAttribute('aria-hidden', 'false');
  // 前回の状態が残っていると、いきなり最終形から始まってしまう
  fx.classList.remove('opening');
  pillar.style.removeProperty('--pillar');
  flash.style.opacity = '0';

  // 1段目: 魔法陣
  playSfx('gachaCharge');
  outer.classList.add('spin');
  inner.classList.add('spin');
  await racedSleep(T_CHARGE * 1000);

  // 2段目: 品質の色で予告
  pillar.style.setProperty('--pillar', PILLAR[rarity]);
  pillar.classList.add('rise');
  await racedSleep(T_PILLAR * 1000);

  // 3段目: 開封
  playSfx('gachaOpen');
  if (rarity !== 'normal') setTimeout(() => playSfx('gachaRare'), 220);
  fx.classList.add('opening');
  await racedSleep(T_OPEN * 1000);

  outer.classList.remove('spin');
  inner.classList.remove('spin');
  pillar.classList.remove('rise');
  result.classList.remove('hidden');
}

function closeFx(): void {
  const fx = $('#gacha-fx');
  fx.classList.add('hidden');
  fx.setAttribute('aria-hidden', 'true');
  fx.classList.remove('opening');
  $('#gacha-circle-outer').classList.remove('spin');
  $('#gacha-circle-inner').classList.remove('spin');
  $('#gacha-pillar').classList.remove('rise');
}

// ===== 画面 =====

export function renderShop(): void {
  const rows = GACHA_ODDS.map(o => {
    const r = RARITIES[o.rarity];
    const name = r.name || '通常';
    return `<div class="gacha-odd"><span style="color:${r.cssColor}">${name}</span>`
      + `<b>${o.pct}%</b></div>`;
  }).join('');
  $('#gacha-odds').innerHTML = rows;

  const have = state.tickets;
  const btn = $<HTMLButtonElement>('#gacha-draw');
  btn.disabled = have < GACHA_COST || running;
  $('#gacha-have').textContent = have >= GACHA_COST
    ? `所持チケット: ${have}枚`
    : 'チケットが足りない。1日1枚、最初に開いた時に配られる。';
}

async function draw(): Promise<void> {
  if (running) return;
  if (state.tickets < GACHA_COST) {
    showToast('チケットが足りない。明日また来よう。');
    return;
  }
  const rarity = rollGachaRarity();
  const spell = makeSpell(rarity);
  if (!spell) {                       // 構成が作れない = 起こらないはずの事故
    showToast('抽選に失敗した。チケットは減っていない。');
    return;
  }

  running = true;
  state.tickets -= GACHA_COST;
  save();                             // 演出の途中で閉じられても消費は確定させる
  notify();
  renderShop();

  const r = RARITIES[rarity];
  $('#gacha-result-rarity').textContent = r.name || '通常';
  $('#gacha-result-rarity').style.color = r.cssColor;
  $('#gacha-result-name').textContent = spell.name;
  $('#gacha-result-name').style.color = r.cssColor;
  $('#gacha-result-note').textContent =
    `魔導値 ${spellMagicValue(spell.stats)} / 残りチケット ${state.tickets}枚`;

  await runFx(rarity);

  // 受け取りは演出の後。先に入れると、結果を見る前に魔導書が動いて見える
  addSpell(spell);
  save();
  notify();
  running = false;
  renderShop();
}

export function initShop(): void {
  $('#gacha-draw').addEventListener('click', () => { void draw(); });
  $('#gacha-close').addEventListener('click', () => {
    playSfx('click');
    closeFx();
  });
  // 演出の途中を押したら結果まで飛ばす(結果が出た後の誤爆では閉じない)
  $('#gacha-fx').addEventListener('click', ev => {
    if ((ev.target as HTMLElement).closest('#gacha-result')) return;
    skip?.();
  });
  $('#gacha-art').innerHTML =
    '<img src="img/fx/circle.png" alt="" width="180" height="180">';
}

// ショップを開いた時に呼ぶ。専用BGMに切り替える。
export function enterShop(): void {
  renderShop();
  playBgm('gacha');
}
