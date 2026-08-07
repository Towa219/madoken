// 交易所のガチャ(魔導の抽選)
//
// チケット1枚で魔法を1本引く。品質は GACHA_ODDS の確率で決め、
// ただし GACHA_LIVE が false の間は「お試し」で、演出と結果は出るが
// チケットは減らず魔法も入らない。
// 系統は運任せ。その系統が成立する構成のうち最も魔導値が高いものを作る
// (最深部の報酬 grantBossReward と同じ作り方に揃えてある)。
//
// 演出は Pixi ではなく CSS で組んでいる。戦闘の Pixi は戦闘画面でしか
// 動いておらず、この3秒のために2つ目のレンダラを起こすと、
// 開くたびに GPU の確保が走って重い。回転・拡大・発光は CSS の方が素直。

import {
  GACHA_COST, GACHA_LIVE, GACHA_PRIZES, RARITIES, rollGachaPrize,
} from '../shared/data';
import {
  computeSpell, ENHANCE_MAX, finalStats, randomComposition,
  spellDisplayName, spellMagicValue, spellNameFor,
} from '../shared/spellcraft';
import { addSpell, notify, save, state } from './state';
import { showToast } from './lab';
import { playBgm, playSfx } from './sound';
import { gachaOutcomeFor } from '../shared/gacha';
import type { GachaOutcome } from '../shared/gacha';
import type { ElementCounts, Rarity, Spell } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// 品質ごとの光の色。予告の柱にこの色を使い、出る前に期待させる。
// 通常だけは白のままにして、色が付いた時点で「当たり」と分かるようにする。
// 研究Pの色。上のバー(#rp-display)と同じ色にして、何が増えるか分かるようにする。
// 光の柱には使わない ― レジェンドの金色と近く、見分けが付かないため。
const RP_COLOR = '#ffdd66';

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

// 新しくもらう1本を組み立てる
function newSpellOf(counts: ElementCounts, rarity: Rarity): Spell {
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

// 引いた結果。まだ持ち物には反映しない(演出の後で入れる)。
// 新規か強化かの判断そのものは shared/gacha.ts に置いてある。
function rollOutcome(): GachaOutcome | null {
  const prize = rollGachaPrize();
  if (prize.kind === 'rp') return { kind: 'rp', amount: prize.amount };
  // 素材の数は今の調合スロットに合わせる(最深部の報酬と同じ扱い)。
  // 系統を1つ選ぶだけでは、素材が足りない系統を引いた時に何も出ない。
  const picked = randomComposition(Math.max(3, state.slots));
  if (!picked) return null;
  return gachaOutcomeFor(state.spells, picked.counts, prize);
}

// 引いたものを実際に持ち物へ反映する。お試し中は呼ばない。
function applyOutcome(o: GachaOutcome): void {
  if (o.kind === 'rp') { state.researchP += o.amount; return; }
  if (o.kind === 'new') { addSpell(newSpellOf(o.counts, o.rarity)); return; }
  if (o.kind === 'max') return;
  const sp = o.owned;
  if (o.rarityUp) {
    sp.rarity = o.rarity;
    // 品質が変わると上位品質の真名に変わる(同じ構成なら名前は一意に決まる)
    sp.name = spellNameFor(sp.recipe, sp.rarity);
  }
  sp.level = o.level;
  sp.stats = finalStats(sp.recipe, sp.level, sp.rarity);
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
  const rows = GACHA_PRIZES.map(p => {
    const color = p.kind === 'rp' ? RP_COLOR : RARITIES[p.rarity].cssColor;
    const name = p.kind === 'rp'
      ? `研究P+${p.amount}` : (RARITIES[p.rarity].name || '通常の魔法');
    return `<div class="gacha-odd"><span style="color:${color}">${name}</span>`
      + `<b>${p.pct}%</b></div>`;
  }).join('');
  $('#gacha-odds').innerHTML = rows;
  // 本番前は、押す前に分かる場所へ断りを出す。
  // 結果を見てから「受け取れません」では、当たった時に落胆させる。
  $('#gacha-notice').innerHTML = GACHA_LIVE ? ''
    : '<b>🔧 お試し公開中</b> — 引く感触を見てもらうための状態です。'
      + 'チケットは減らず、出た魔法も受け取れません。';

  const have = state.tickets;
  const btn = $<HTMLButtonElement>('#gacha-draw');
  // お試し中はチケットを使わないので、0枚でも押せる
  btn.disabled = running || (GACHA_LIVE && have < GACHA_COST);
  btn.textContent = GACHA_LIVE ? '引く(チケット1枚)' : '引いてみる(お試し)';
  if (!GACHA_LIVE) {
    $('#gacha-have').textContent =
      `お試し中。チケットは減らず、引いた魔法も受け取れない(所持 ${have}枚)。`;
  } else {
    $('#gacha-have').textContent = have >= GACHA_COST
      ? `所持チケット: ${have}枚`
      : 'チケットが足りない。1日1枚、最初に開いた時に配られる。';
  }
}

async function draw(): Promise<void> {
  if (running) return;
  if (GACHA_LIVE && state.tickets < GACHA_COST) {
    showToast('チケットが足りない。明日また来よう。');
    return;
  }
  const outcome = rollOutcome();
  if (!outcome) {                     // 構成が作れない = 起こらないはずの事故
    showToast('抽選に失敗した。チケットは減っていない。');
    return;
  }

  running = true;
  if (GACHA_LIVE) {
    state.tickets -= GACHA_COST;
    save();                           // 演出の途中で閉じられても消費は確定させる
    notify();
  }
  renderShop();
  showResult(outcome);

  // 光の柱の色は「引いた品質」で出す。重複で強化になる時も、
  // 何を引いたのかは同じように見せる(色だけ地味にすると当たりが分からない)。
  await runFx(pillarRarity(outcome));

  // 受け取りは演出の後。先に入れると、結果を見る前に魔導書が動いて見える
  if (GACHA_LIVE) {
    applyOutcome(outcome);
    save();
    notify();
  }
  running = false;
  renderShop();
}

// 光の柱の色に使う品質。研究Pは通常と同じ白にする。
// 色が付いたら上位品質、という見分け方を崩さないため。
function pillarRarity(o: GachaOutcome): Rarity {
  return o.kind === 'rp' ? 'normal' : o.rarity;
}

// 結果カードの中身。重複した時は「+1」であることを一目で分かるようにする。
function showResult(o: GachaOutcome): void {
  if (o.kind === 'rp') {
    $('#gacha-result-rarity').textContent = '研究P';
    $('#gacha-result-rarity').style.color = RP_COLOR;
    $('#gacha-result-name').textContent = `研究P +${o.amount}`;
    $('#gacha-result-name').style.color = RP_COLOR;
    $('#gacha-result-note').textContent = GACHA_LIVE
      ? `所持 ${state.researchP} → ${state.researchP + o.amount}`
        + ` / 残りチケット ${state.tickets}枚`
      : `所持 ${state.researchP}`
        + ' ※お試し中。実際には増えず、チケットも減っていない。';
    return;
  }
  const r = RARITIES[o.rarity];
  const trial = GACHA_LIVE ? ''
    : ' ※お試し中。実際には反映されず、チケットも減っていない。';

  if (o.kind === 'new') {
    const spell = newSpellOf(o.counts, o.rarity);
    $('#gacha-result-rarity').textContent = r.name || '通常';
    $('#gacha-result-rarity').style.color = r.cssColor;
    $('#gacha-result-name').textContent = spell.name;
    $('#gacha-result-name').style.color = r.cssColor;
    $('#gacha-result-note').textContent =
      `魔導値 ${spellMagicValue(spell.stats)}`
      + (GACHA_LIVE ? ` / 残りチケット ${state.tickets}枚` : '') + trial;
    return;
  }

  const owned = o.owned;
  if (o.kind === 'max') {
    $('#gacha-result-rarity').textContent = `${r.name || '通常'}(重複)`;
    $('#gacha-result-rarity').style.color = r.cssColor;
    $('#gacha-result-name').textContent = spellDisplayName(owned);
    $('#gacha-result-name').style.color = RARITIES[owned.rarity].cssColor;
    $('#gacha-result-note').textContent =
      `すでに最大強化(+${ENHANCE_MAX})で、品質も上がらなかった。`
      + (GACHA_LIVE ? ` / 残りチケット ${state.tickets}枚` : '') + trial;
    return;
  }

  // 強化。品質も上がる時は、上がった後の名前を見せる
  const after = o.rarityUp ? o.rarity : owned.rarity;
  const shown = o.rarityUp ? spellNameFor(owned.recipe, after) : owned.name;
  const stats = finalStats(owned.recipe, o.level, after);
  $('#gacha-result-rarity').textContent =
    `${r.name || '通常'}(重複 → 強化)`;
  $('#gacha-result-rarity').style.color = r.cssColor;
  $('#gacha-result-name').textContent = `${shown} +${o.level}`;
  $('#gacha-result-name').style.color = RARITIES[after].cssColor;
  $('#gacha-result-note').textContent =
    `すでに持っている魔法。+${owned.level} → +${o.level} に強化`
    + (o.rarityUp ? `(品質も ${RARITIES[after].name} に上がった)` : '')
    + ` / 魔導値 ${spellMagicValue(owned.stats)} → ${spellMagicValue(stats)}`
    + (GACHA_LIVE ? ` / 残りチケット ${state.tickets}枚` : '') + trial;
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

// 交易所を開いた時に呼ぶ。専用BGMに切り替える。
export function enterShop(): void {
  renderShop();
  playBgm('gacha');
}
