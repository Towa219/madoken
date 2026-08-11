// エントリポイント: 画面切替・出撃準備・戦闘結果の処理

import { BattleManager } from './battle';
import { ELEMENTS, EQUIP_MAX, isBossStage } from '../shared/data';
import { initLab, renderLab, showToast } from './lab';
import { renderManual } from './manual';
import { renderPets } from './pet';
import {
  initDuelCall, initOnline, coopTryCast, duelTryCast, inBattleView,
  setBattleTabOpener,
  releaseNickname, renderNickField, syncLobbyVisibility,
} from './lobby';
import { selectedStage, setSelectedStage } from './stage';
import {
  deleteCloudSave, initCloudUI, renderCloudStatus, scheduleCloudSave,
} from './cloudsave';
import { initWelcome, waitForServer, watchVersion } from './boot';
import { watchDailyBonus } from './daily';
import { enterShop, initShop } from './gacha';
import { initTrade, renderTradePanel, tradeInProgress } from './trade';
import { installNoZoom } from './nozoom';
import { currentAllyCharId, renderAllyPicker } from './allypick';
import { ALLY_RP_MUL } from '../shared/allies';
import { renderTips } from './tips';
import { initShare } from './share';
import { loadArtwork } from './artwork';
import { initCharPicker, renderCharPickers } from './character';
import { initAdmin } from './admin';
import { initSound, initSoundUI, playBgm, playSfx, renderSoundUI } from './sound';
import { combatPower } from '../shared/spellcraft';
import { BUILD_DATE, COPYRIGHT, VERSION } from '../shared/version';
import {
  addElements, equippedSpells, notify, onChange, resetSave, state,
} from './state';
import type { BattleResult } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const battle = new BattleManager();
let lastStage = 1;

// ===== タブ切替 =====

type Tab = 'lab' | 'book' | 'battle' | 'shop' | 'manual' | 'pet' | 'settings';

// 戦闘中(ソロ・共闘・決闘)はタブを移動させない。
// 移動できると、進行中の戦闘が見えないまま進んでしまう。
function battleInProgress(): boolean {
  return battle.isActive() || inBattleView();
}

// 画面に並んでいる順(index.html の nav と同じにしておく)
const TAB_BUTTONS = [
  '#tab-lab', '#tab-battle', '#tab-shop', '#tab-book', '#tab-manual',
  '#tab-pet', '#tab-settings',
];

// 戦闘中・取引中は、今表示しているタブ以外を押せなくする
function updateTabLock(): void {
  const fighting = battleInProgress();
  const locked = fighting || tradeInProgress();
  const why = fighting
    ? '戦闘中は移動できない(決着をつけるか撤退する)'
    : '取引中は移動できない(取引を終えるかやめる)';
  for (const sel of TAB_BUTTONS) {
    const b = $<HTMLButtonElement>(sel);
    const keep = b.classList.contains('active');
    b.disabled = locked && !keep;
    b.title = b.disabled ? why : '';
  }
}

// 今どのタブを見ているか。交易所から出た時に曲を戻すために覚えておく。
let curTab: Tab = 'lab';

// 共闘・決闘が始まった時に、戦闘タブへ強制的に移す。
//
// ★ switchTab を使ってはいけない。
//   あれは「戦闘中は移動できない」で弾く作りなので、
//   まさに戦闘が始まった瞬間に呼ぶと自分で自分を止めてしまう。
//   ここは画面の表示だけを切り替える(移動の可否は問わない)。
function forceBattleTab(): void {
  if (curTab === 'battle') return;
  curTab = 'battle';
  $('#lab-screen').classList.add('hidden');
  $('#book-screen').classList.add('hidden');
  $('#shop-screen').classList.add('hidden');
  $('#manual-screen').classList.add('hidden');
  $('#pet-screen').classList.add('hidden');
  $('#settings-screen').classList.add('hidden');
  $('#battle-screen').classList.remove('hidden');
  for (const sel of TAB_BUTTONS) {
    $(sel).classList.toggle('active', sel === '#tab-battle');
  }
}

function switchTab(tab: Tab): void {
  // 戦闘中の移動を止める(ボタンを無効にしているが、念のためここでも弾く)
  if (battleInProgress()) {
    showToast('戦闘中は他の画面に移動できない。決着をつけるか撤退しよう。');
    return;
  }
  // 取引の卓は画面全体をふさぐので、そもそも押せない。
  // それでもここで弾いておく ― 卓を開いたまま素材庫を使えると、
  // 出すと約束したエレメントを先に使えてしまう。
  if (tradeInProgress()) {
    showToast('取引中は他の画面に移動できない。取引を終えるかやめよう。');
    return;
  }
  playSfx('click');
  const prev = curTab;
  curTab = tab;
  $('#lab-screen').classList.toggle('hidden', tab !== 'lab');
  $('#book-screen').classList.toggle('hidden', tab !== 'book');
  $('#battle-screen').classList.toggle('hidden', tab !== 'battle');
  $('#shop-screen').classList.toggle('hidden', tab !== 'shop');
  $('#manual-screen').classList.toggle('hidden', tab !== 'manual');
  $('#pet-screen').classList.toggle('hidden', tab !== 'pet');
  $('#settings-screen').classList.toggle('hidden', tab !== 'settings');
  $('#tab-lab').classList.toggle('active', tab === 'lab');
  $('#tab-book').classList.toggle('active', tab === 'book');
  $('#tab-battle').classList.toggle('active', tab === 'battle');
  $('#tab-shop').classList.toggle('active', tab === 'shop');
  $('#tab-manual').classList.toggle('active', tab === 'manual');
  $('#tab-pet').classList.toggle('active', tab === 'pet');
  $('#tab-settings').classList.toggle('active', tab === 'settings');
  if (tab === 'shop') { enterShop(); renderTradePanel(); }
  // 交易所から出たらロビーの曲に戻す(専用BGMを引きずらない)
  else if (prev === 'shop') playBgm('lobby');
  if (tab === 'manual') renderManual();
  if (tab === 'pet') void renderPets();
  if (tab === 'settings') {
    renderCloudStatus();
    renderCharPickers();
    renderSoundUI();
    initShare(); // 共有文に今の戦闘力・発見数を載せ直す
  }
  if (tab === 'battle' && !battle.isActive()) {
    showSetup();
  }
}

// ===== 出撃準備(ソロ) =====

function showSetup(): void {
  // 隠すのを先にする。inBattleView() は戦闘画面が出ているかで判断するので、
  // 順番を逆にすると「まだ戦闘中」と見なされてロビー曲に戻らない。
  $('#battle-view').classList.add('hidden');
  $('#battle-overlay').classList.add('hidden');
  $('#battle-setup').classList.remove('hidden');
  // 共闘/決闘は同じ画面で進行中のことがある。その最中に戻ってきただけで
  // ロビー曲に変わってしまわないよう、戦っていない時だけ戻す。
  if (!inBattleView()) playBgm('lobby');
  syncLobbyVisibility();
  renderSetup();
}

// 出撃準備。ステージはソロと共闘で共通のものを選ぶ。
//
// 以前は「戦闘」タブのボタン列(ソロ用)と、オンラインの選択欄(共闘用)で
// 同じことを2か所選ばせていた。押した瞬間にソロが始まる作りだったので、
// 共闘用にステージだけ選ぶことができなかった。
// ここでは「選ぶ」と「挑む」を分け、挑み方をあとから選べるようにしている。
function renderSetup(): void {
  const stage = selectedStage(state.maxStage);
  const boss = isBossStage(stage);
  const spells = equippedSpells();

  const sel = $('#stage-select');
  sel.innerHTML = '';
  for (let i = 1; i <= state.maxStage; i++) {
    const b = document.createElement('button');
    const isBoss = isBossStage(i);
    b.textContent = isBoss ? `${i} 👑` : `${i}`;
    b.className = (isBoss ? 'boss' : '') + (i === stage ? ' selected' : '');
    b.addEventListener('click', () => {
      setSelectedStage(i);
      playSfx('select');
      renderSetup();
    });
    sel.appendChild(b);
  }

  // ボスはサーバー側で判定する必要があるので共闘部屋からのみ。
  // 撃破の記録(スロット解放・討伐報酬)が、ここを通らないと残らない。
  const soloBtn = $<HTMLButtonElement>('#btn-solo-go');
  soloBtn.textContent = `ステージ${stage}へ ソロで出撃`;
  soloBtn.disabled = boss || spells.length === 0;
  $<HTMLButtonElement>('#btn-create-room').textContent =
    `ステージ${stage}の共闘部屋を作る`;

  // お供欄(旗が false の間は中で何もせず、何も出さない)
  renderAllyPicker();

  $('#setup-msg').textContent = spells.length === 0
    ? '魔法を1つ以上装備しないと出撃できない。研究室で調合・装備しよう。'
    : boss
      ? `👑 ステージ${stage}はボス戦。共闘部屋から挑む(1人でも可)。`
      : '';
}

async function startBattle(stage: number): Promise<void> {
  const spells = equippedSpells();
  if (spells.length === 0) {
    $('#setup-msg').textContent = '魔法を1つ以上装備しないと出撃できない。';
    return;
  }
  if (isBossStage(stage)) {
    $('#setup-msg').textContent =
      'ボス戦はソロでは挑めない。共闘部屋を作ろう(1人でも可)。';
    return;
  }
  playBgm('battle'); // ボス戦はこの手前で弾いている(共闘部屋のみ)
  lastStage = stage;
  setSelectedStage(stage);
  $('#battle-setup').classList.add('hidden');
  $('#battle-view').classList.remove('hidden');
  $('#battle-overlay').classList.add('hidden');
  syncLobbyVisibility(); // 戦闘中はロビーも隠す(同じ画面に並んでいるため)
  // お供を連れて行くかは、出撃を押した時点の選択で決まる。
  // 戦闘が始まった後で入れ替わることはない。
  allyCameAlong = currentAllyCharId();
  await battle.start($('#game-canvas'), stage, spells, onBattleEnd, allyCameAlong);
}

// この戦闘にお供が同行したか。研究Pの倍率に使うので、
// 戦闘が終わるまで覚えておく(その間に選択欄を触られても影響しない)。
let allyCameAlong: number | null = null;

// ===== 戦闘結果(ソロ) =====

function onBattleEnd(r: BattleResult): void {
  addElements(r.drops);
  // お供を連れて行った回は研究Pを減らす。
  // 明らかに楽になるので、そのぶん実入りを下げて釣り合いを取る。
  const withAlly = allyCameAlong !== null;
  const rp = withAlly ? Math.round(r.rp * ALLY_RP_MUL) : r.rp;
  state.researchP += rp;
  if (r.win) {
    state.bestStage = Math.max(state.bestStage, r.stage);
    state.maxStage = Math.max(state.maxStage, r.stage + 1);
  }

  const overlay = $('#battle-overlay');
  const title = r.win ? '勝利!' : (r.escaped ? '撤退した…' : '敗北…');
  const titleClass = r.win ? 'win' : 'lose';
  const dropChips = r.drops.length > 0
    ? r.drops.map(d =>
        `<span class="drop-chip" style="color:${ELEMENTS[d].cssColor}">${ELEMENTS[d].name}</span>`,
      ).join('')
    : '<span style="color:#8888aa">なし(ソロ戦ではエレメントは手に入らない)</span>';

  overlay.innerHTML =
    `<div class="result-box">` +
    `<h2 class="${titleClass}">${title}</h2>` +
    `<div>ステージ ${r.stage}</div>` +
    `<div class="drops">獲得エレメント: ${dropChips}</div>` +
    (rp > 0
      ? `<div style="color:#ffdd66">研究P +${rp}`
        // 減った理由をその場で見せる。黙って少ないと不具合に見える。
        + (withAlly
          ? `<small style="color:#aa9966"> (お供と一緒なので ×${ALLY_RP_MUL})</small>`
          : '')
        + '</div>'
      : `<div style="color:#8888aa">${r.escaped ? '撤退' : '敗北'}したため研究Pは得られない。</div>`) +
    `<div style="margin-top:16px; display:flex; gap:8px; justify-content:center">` +
    `<button id="btn-again">${r.win ? 'もう一度' : '再挑戦'}</button>` +
    (r.win && r.stage + 1 <= state.maxStage && !isBossStage(r.stage + 1)
      ? `<button id="btn-next">次のステージへ</button>` : '') +
    (r.win && isBossStage(r.stage + 1)
      ? `<div class="note" style="margin-top:8px">次はボス戦。「共闘部屋を作る」から挑もう(1人でも可)。</div>` : '') +
    `<button id="btn-back">準備画面へ</button>` +
    `</div></div>`;
  overlay.classList.remove('hidden');

  overlay.querySelector('#btn-again')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    void startBattle(lastStage);
  });
  overlay.querySelector('#btn-next')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    void startBattle(lastStage + 1);
  });
  overlay.querySelector('#btn-back')?.addEventListener('click', showSetup);

  notify();
}

// ===== 初期化 =====

function updateTopbar(): void {
  $('#rp-display').textContent = `研究P: ${state.researchP}`;
  $('#ticket-display').textContent = `🎟 チケット: ${state.tickets}`;
  $('#power-display').textContent = `⚔ 戦闘力: ${combatPower(equippedSpells())}`;
}

function renderFooter(): void {
  $('#app-footer').innerHTML =
    `<span class="fver">魔導研究記 v${VERSION}(${BUILD_DATE} 更新)</span><br>${COPYRIGHT}`;
}

function main(): void {
  initLab();

  // サーバーの起床を待ちつつ、初回なら名前を決めてもらう。
  // (名前が決まってからオンラインを初期化 = そのまま自動接続される)
  renderTips();
  // public/img/ に画像があれば読み込む(無ければ図形描画のまま)。
  // 読み終わってからキャラ選択欄を描き直すと、立ち絵付きの選択肢になる。
  void loadArtwork().then(() => renderCharPickers());
  let onlineReady = false;
  const startOnline = (): void => {
    renderNickField();
    if (!onlineReady) {
      onlineReady = true;
      initDuelCall();   // 決闘の呼び出し札(どのタブにいても出る)
      initOnline();
    }
  };
  void waitForServer().then(ok => {
    // サーバーが落ちている時でもソロは遊べるようにする(名前は後から登録)
    if (ok) initWelcome(startOnline);
    else startOnline();
  });
  // この画面が古くなっていないか見張る(開きっぱなしだと直しが届かない)
  watchVersion();
  // 1日1枚のログインボーナス(日付が変わっていれば配る)
  watchDailyBonus();
  initShop();
  initTrade();
  installNoZoom();

  // 共闘・決闘が始まったら戦闘タブへ移す(研究室などで受けても見えるように)
  setBattleTabOpener(forceBattleTab);
  $('#tab-lab').addEventListener('click', () => switchTab('lab'));
  $('#tab-book').addEventListener('click', () => switchTab('book'));
  $('#tab-manual').addEventListener('click', () => switchTab('manual'));
  $('#tab-pet').addEventListener('click', () => switchTab('pet'));
  $('#tab-battle').addEventListener('click', () => switchTab('battle'));
  $('#tab-shop').addEventListener('click', () => switchTab('shop'));
  $('#tab-settings').addEventListener('click', () => switchTab('settings'));

  $('#btn-solo-go').addEventListener('click', () => {
    void startBattle(selectedStage(state.maxStage));
  });

  const resetBtn = $('#btn-reset');
  resetBtn.addEventListener('click', () => {
    // confirmが使えない環境(公開版のiframe等)があるため2度押し確認
    if (resetBtn.dataset.arm === '1') {
      resetBtn.dataset.arm = '';
      resetBtn.textContent = '初期化する';
      // クラウド側のセーブを消してから名前を手放す(順番が逆だと本人確認に失敗する)
      void deleteCloudSave().then(() => releaseNickname());
      resetSave();
      renderNickField(); // ニックネームも再登録できるようになる
      $('#reset-msg').textContent =
        '初期化した。ニックネームとランキングの記録も解放された。';
      showToast('セーブデータを初期化した。新しい名前を決めよう。');
      initWelcome(startOnline); // 名前を決め直してもらう
    } else {
      resetBtn.dataset.arm = '1';
      resetBtn.textContent = '本当に初期化する? (取り消せない)';
      $('#reset-msg').textContent = 'もう一度押すと実行される。';
      setTimeout(() => {
        resetBtn.dataset.arm = '';
        resetBtn.textContent = '初期化する';
        $('#reset-msg').textContent = '';
      }, 4000);
    }
  });

  // キーボード 1〜5 で詠唱(ソロ/共闘)
  window.addEventListener('keydown', ev => {
    const n = parseInt(ev.key, 10);
    // 装備数が増えればキーも増える(6つ目まで)
    if (!(n >= 1 && n <= EQUIP_MAX)) return;
    if (!$('#battle-view').classList.contains('hidden')) battle.tryCast(n - 1);
    else if (!$('#coop-view').classList.contains('hidden')) coopTryCast(n - 1);
    else if (!$('#duel-view').classList.contains('hidden')) duelTryCast(n - 1);
  });

  onChange(() => {
    updateTopbar();
    renderLab();
    renderCloudStatus();
    scheduleCloudSave(); // 変更のたびにクラウドへ(まとめて数秒後に1回)
    if (!$('#battle-setup').classList.contains('hidden')) renderSetup();
  });

  // 音は素材が無ければ無音のまま。読み込めたら設定画面を作る
  void initSound().then(() => { initSoundUI(); playBgm('lobby'); });

  window.setInterval(updateTabLock, 400);

  initCloudUI();
  initCharPicker('#char-picker');    // 設定タブ
  initCharPicker('#welcome-chars');  // 初回起動
  initShare();
  initAdmin();   // 「ペット」タブは管理者モードの間だけ出る(試験中)
  updateTopbar();
  renderLab();
  renderFooter();
}

main();
