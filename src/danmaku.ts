// ボス撃破後に流れるコメント弾幕(ニコニコ動画ふう)
//
// 画面の右から左へ、称賛のコメントが流れる。
//
// ★ 全員が「同じもの」を見ること。
//   出す言葉と順番を各自の乱数で決めると、隣の人とは違う弾幕になる。
//   同じ瞬間を一緒に見て盛り上がるのが狙いなので、部屋IDとステージから
//   種を作り、全員が同じ並びを引くようにしてある。
//   (サーバーから配る手もあるが、通信を増やさずに済むこちらを採った。
//    部屋IDは同室の全員で必ず一致する。)
//
// ★ 操作の邪魔をしないこと。pointer-events は none。
//   ボス撃破の4秒後には次のステージが始まるので、出し切るまでを
//   短く抑えてある(下の 幕 を参照)。

import { isBossStage } from '../shared/data';

// どのボスを倒した時に流すか。
//
// ★ 2026-08-15: ステージ5だけのお試しから、ボス戦すべてに広げた。
//   ボスは5の倍数のステージにしか出ないので、判定は isBossStage に任せる
//   (節目を動かしても勝手に追いてくる)。
//   一部のボスだけに戻したくなったら、ここで stage を見て絞ればよい。
export function isDanmakuStage(stage: number): boolean {
  return isBossStage(stage);
}

// 流す言葉。称賛を多めに。
//
// ★ ニコニコ的な言い回しを混ぜるが、意味の分からない内輪ネタは避ける。
//   「うぽつ」(投稿乙)のような動画側の挨拶はここでは筋が通らないので入れない。
// ★ 「888…」は拍手の意味(パチパチ)。ニコニコでいちばん通りの良い称賛。
const 称賛: string[] = [
  '８８８８８８８８',
  '８８８８８８',
  'うぉぉぉぉぉぉ',
  'つよい',
  'つよすぎる',
  'GJ!!',
  'ナイスファイト',
  '神プレイ',
  'かっこよすぎ',
  'よくやった！',
  'お見事',
  'すげえええええ',
  '討伐乙！',
  '完璧じゃん',
  'ここすき',
  'ほれぼれする',
  'よくぞ倒した',
  '拍手喝采',
  '英雄はここにいた',
  'あざやか',
  '天才かよ',
  'しびれた',
  '鳥肌立った',
  '研究者の鑑',
  '伝説の始まり',
  'よく耐えた…',
  'ナイス判断',
  '立ち回りが上手い',
  '最後の一撃きれいだった',
  'よくぞここまで',
  '文句なし',
  'あっぱれ',
  'つえー',
  '語彙力が消えた',
  '惚れ直した',
];

// 名前入りの称賛。{名} に、その部屋に居た研究者の名前が入る。
//
// ★ これがいちばん効く。「誰か」ではなく「自分たち」が褒められるので、
//   同じ卓に居た人の顔が浮かぶ。名前が取れない時は使わない。
// ★ 口調はニコニコ寄りに崩す(〜、！、…)。畏まると弾幕らしくなくなる。
const 名前入り: string[] = [
  '{名}の封印を入れるタイミング痺れた〜',
  '{名}の判断が的確すぎる',
  '{名}のヒール神がかってた',
  '{名}ナイス盾！',
  '{名}の最後の一撃かっこよかった',
  '{名}つよすぎでしょ',
  '{名}ありがとう…！',
  '{名}がずっと耐えてくれてた',
  '{名}の火力えぐい',
  '{名}よく粘った〜',
  '{名}の護符が効いてる',
  '{名}が実質MVP',
  '{名}の切り替え上手い',
  '{名}に惚れた',
  '{名}の立ち回り完璧',
  '{名}が居なかったら負けてた',
  '{名}冷静すぎる',
  '{名}お疲れ〜！',
  '{名}の魔法きれいだった',
  '{名}やるじゃん',
  '{名}それ狙ってたでしょ',
  '{名}の詠唱ぴったりだった',
];

// 場を和ませる側。数は少なめにする。
const 合いの手: string[] = [
  'ｗｗｗｗｗｗ',
  '草',
  '乙',
  '初見です',
  '何回でも見たい',
  'ここで泣いた',
  '手に汗握った',
  'そのレシピ教えて',
  '装備なに積んでる？',
  'MP足りてたの？',
  '心臓に悪い',
  'ヒヤヒヤした',
];

// ★ 日本語(と英字)以外が紛れ込んでいないか、念のため通す。
//   キリル文字などが混ざると読めない言葉が流れる。
const 日本語だけ = (s: string) => !/[Ѐ-ӿ؀-ۿ]/.test(s);

// 実際に流す言葉を組み立てる。称賛を多めにする。
//
// ★ 名前入りは「その部屋に居た人ぶん」しか作れないので、
//   人数が少ないほど同じ名前が並ぶ。多くしすぎると名指しが続いて
//   くどくなるので、全体のおよそ1/3に収まる量だけ混ぜる。
function 言葉を作る(名前: readonly string[]): string[] {
  const 素 = 称賛.filter(日本語だけ);
  const 出来上がり: string[] = [...素, ...素, ...素, ...合いの手];
  if (名前.length > 0) {
    const 名入り = 名前.flatMap(n => 名前入り.map(t => t.replace('{名}', n)));
    // 称賛の山と釣り合う量だけ入れる(多すぎると名指しばかりになる)。
    const 欲しい数 = Math.round(出来上がり.length / 2);
    for (let i = 0; i < 欲しい数; i++) 出来上がり.push(名入り[i % 名入り.length]);
  }
  return 出来上がり;
}

// 幕(出し切るまでの組み立て)
//
// ★ 長さに関わらず「渡り切る時間」を同じにする(本家ニコニコと同じ)。
//   結果として長い文ほど速く流れる。読み終わるのにかかる時間が
//   文の長さで変わらないので、長い文だけ画面に居座らない。
//
// ★ そのぶん、後ろの長い文が前の短い文に追いつく。速さが違う以上
//   「前の尻尾が抜けたら出す」だけでは足りない。下の 追いつかない時刻()
//   で、渡り切るまでの間ずっと追突しない出発時刻を計算している。
//   (これを怠って実際に文字が重なり、読めなくなった。2026-08-15)
// ★ 数字は本家に合わせてある。
//   ・渡り切るまで4秒(本家の流れるコメントと同じ)
//   ・文字の大きさは画面の高さの約6.25%
//     (本家の標準の大きさ24pxは、当時の再生画面の高さ384pxのちょうど6.25%)
//   ・行の高さは文字の1.25倍。画面をほぼ端から端まで車線に使う
const 発射時間 = 3.4;      // この秒数のあいだに撃ち出したい(混んでいれば延びる)
const 横断秒 = 4.0;        // 右端から左端まで渡る時間(長さによらず一定)
const 車間 = 40;           // 前のコメントとの最小の空き(px)
const 本数 = 30;           // 流すコメントの数
const 文字比 = 0.0625;     // 画面の高さに対する文字の大きさ
const 行間比 = 1.25;       // 行の高さ = 文字 × これ

// 同じ車線で、前の1本に追いつかない最も早い出発時刻(秒)を返す。
//
//   前: 出発 ta / 文字幅 wa / 速さ va
//   後: 文字幅 wb / 速さ vb
//
// 押さえるのは2点だけでよい(どちらも等速なので、間が縮むのは端でしか起きない)。
//   ① 後が右端に現れた瞬間、前の尻尾がもう車間ぶん先にいること
//   ② 前が左端を抜け切る瞬間、後がまだ左端まで来ていないこと
function 追いつかない時刻(
  ta: number, wa: number, va: number, vb: number, 画面幅: number,
): number {
  const 条件1 = (wa + 車間) / va;
  const 条件2 = 横断秒 - (画面幅 - 車間) / vb;
  return ta + Math.max(条件1, 条件2, 0);
}

// 種から同じ並びを作るための乱数(mulberry32)。
// Math.random と違い、同じ種なら誰の端末でも同じ順に出る。
function 乱数器(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function 種にする(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let 片付け: number[] = [];

// 出しかけのものを消す。続けて2回呼ばれても重ならないように。
export function stopDanmaku(): void {
  for (const t of 片付け) window.clearTimeout(t);
  片付け = [];
  const host = document.getElementById('danmaku');
  if (!host) return;
  host.innerHTML = '';
  host.classList.add('hidden');
}

// 弾幕を流す。
//
// seedText と 名前 が同じなら、誰の画面でもまったく同じ並びになる。
// 名前は部屋に居る全員(自分も含む)を、全端末で同じ順に渡すこと。
export function playDanmaku(seedText: string, 名前: readonly string[] = []): void {
  const host = document.getElementById('danmaku');
  const view = document.getElementById('coop-view');
  const canvas = document.querySelector('#coop-canvas canvas') as HTMLCanvasElement | null;
  if (!host || !view || !canvas) return;

  stopDanmaku();

  // 盤面(canvas)にぴったり重ねる。#coop-view は position:relative。
  const c = canvas.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const 幅 = Math.round(c.width);
  const 高さ = Math.round(c.height);
  if (幅 < 80 || 高さ < 80) return;   // まだ描かれていない
  host.style.left = `${Math.round(c.left - v.left)}px`;
  host.style.top = `${Math.round(c.top - v.top)}px`;
  host.style.width = `${幅}px`;
  host.style.height = `${高さ}px`;
  host.classList.remove('hidden');

  const rnd = 乱数器(種にする(seedText));

  // 同じ言葉が続けて出ないよう、山を切ってから順に配る。
  // ★ 名前は並び順を揃えてから使う。端末ごとに順番が違うと、
  //   同じ種でも違う弾幕になってしまう。
  const 山 = 言葉を作る([...名前].sort());
  for (let i = 山.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [山[i], 山[j]] = [山[j], 山[i]];
  }

  // ★ 本家と同じく、画面のほぼ全体を車線に使う。
  //   上下を空けると「ニコニコっぽさ」が出ない。流れるのは4秒ほどなので、
  //   その間だけ盤面が読みにくくなるのは祭りのうちと割り切る。
  const 文字 = Math.max(12, Math.round(高さ * 文字比));
  const 車線高 = Math.round(文字 * 行間比);
  const 車線数 = Math.max(4, Math.floor((高さ * 0.97) / 車線高));
  const 上余白 = Math.round((高さ - 車線数 * 車線高) / 2);

  // 文字の幅を先に測る。測らずに車線を決めると、長い言葉が
  // 前の言葉に追いついて重なる。
  const 定規 = document.createElement('div');
  定規.className = 'dm-item';
  定規.style.visibility = 'hidden';
  定規.style.left = '0px';
  定規.style.fontSize = `${文字}px`;
  host.appendChild(定規);
  const 幅を測る = (s: string): number => {
    定規.textContent = s;
    return 定規.offsetWidth;
  };

  // 車線ごとに、直前に流した1本を覚えておく(追突の判定に要る)。
  const 直前: ({ 出発: number; 幅: number; 速さ: number } | null)[] =
    new Array(車線数).fill(null);
  const 予定: { 語: string; 車線: number; 開始: number; 端: number }[] = [];

  for (let i = 0; i < 本数; i++) {
    const 語 = 山[i % 山.length];
    const w = 幅を測る(語);
    // 渡る距離は「画面幅+文字幅」。時間は一定なので、長い文ほど速くなる。
    const 速さ = (幅 + w) / 横断秒;
    const 望み = (i / 本数) * 発射時間;

    // その車線に入れる最も早い時刻。空いていればそのまま望みの時刻。
    const 入れる = (k: number): number => {
      const 前 = 直前[k];
      if (!前) return 望み;
      return Math.max(望み, 追いつかない時刻(前.出発, 前.幅, 前.速さ, 速さ, 幅));
    };

    // 車線は毎回ばらばらの順に当たる。待たずに入れる所があればそこへ、
    // どこも待ちが要るなら「いちばん早く入れる車線」を選ぶ。
    const 順 = [...Array(車線数).keys()];
    for (let k = 順.length - 1; k > 0; k--) {
      const j = Math.floor(rnd() * (k + 1));
      [順[k], 順[j]] = [順[j], 順[k]];
    }
    let 車線 = 順.find(k => 入れる(k) <= 望み + 1e-6) ?? -1;
    if (車線 < 0) {
      車線 = 順[0];
      for (const k of 順) if (入れる(k) < 入れる(車線)) 車線 = k;
    }
    const 開始 = 入れる(車線);
    直前[車線] = { 出発: 開始, 幅: w, 速さ };

    予定.push({ 語, 車線, 開始, 端: -(幅 + w) });
  }
  定規.remove();

  for (const p of 予定) {
    const t = window.setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'dm-item';
      el.textContent = p.語;
      el.style.top = `${上余白 + p.車線 * 車線高}px`;
      el.style.fontSize = `${文字}px`;
      el.style.left = `${幅}px`;
      // ★ 終点と長さを入れ切ってから dm-go を付けて動かすこと。
      //   先に animation-name が効いていると、長さが既定(0秒)のまま
      //   始まって即座に終わり、animationend で自分を消してしまう。
      el.style.setProperty('--dm-end', `${p.端}px`);
      el.style.animationDuration = `${横断秒}s`;
      el.addEventListener('animationend', () => el.remove());
      host.appendChild(el);
      el.classList.add('dm-go');
    }, p.開始 * 1000);
    片付け.push(t);
  }

  // 最後の1本が渡り終えたら畳む。取り残しがあっても必ず消える。
  const 最後 = 予定.reduce((m, p) => Math.max(m, p.開始), 0) + 横断秒;
  片付け.push(window.setTimeout(() => stopDanmaku(), (最後 + 0.6) * 1000));
}
