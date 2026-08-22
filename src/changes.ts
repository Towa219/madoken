// 最近の変更点(流れる帯)
//
// 遊んでいる人に「何が変わったか」を知らせる。仕様を変えても
// 気づかれなければ、変えた意味がその人には届かない。
//
// ★ 1件ずつ日付を持たせ、古くなったものは自動で消す。
//   手で消す作りにすると必ず消し忘れ、「最近の変更点」に
//   ひと月前の話が並ぶことになる。
//
// ★ 書くのは「遊び方がどう変わるか」。実装の話は書かない。
//   「radius を 110 + 60n にした」ではなく
//   「土を1個混ぜるだけで隣の敵まで巻き込む」と書く。

export interface ChangeNote {
  date: string;     // 'YYYY-MM-DD'(この日から数えて DAYS 日ぶん帯に出す)
  version: string;  // その変更が入った版。履歴に並べる時に添える
  // ★ text は「ただの文字」。HTMLのタグを書いてはいけない。
  //   帯も履歴も textContent で入れるので(記号や引用符で壊れないようにする
  //   ための意図した作り)、<b> と書けば <b> という字がそのまま画面に出る。
  //   強調したい時は「かぎ括弧」で括る。
  //   2026-08-15、実際に <b> がそのまま帯に流れた。
  //   test/changes_check.ts が見張っている。
  text: string;
}

// 帯に流す件数。履歴の新しい方からこの数だけ流す。
//
// ★ 日数で切るのをやめた(2026-08-13)。4日で消える作りだったが、
//   間が空くと帯そのものが出なくなり、久しぶりに来た人は何が
//   変わったのか分からないまま遊ぶことになる。件数で切れば、
//   いつ来ても直近のぶんは必ず読める。
//
// ★ 増やしすぎないこと。帯は1周ぶんを読み終えるまで目を離せない。
//   2件で幅3,845px・1周70秒だった(2026-08-13に実測)。1件増えるごとに
//   30秒前後は延びる。4件流していた頃は1周2分を超えていた。
//
// ★ 帯から外れても、変更点そのものは消さない。
//   設定の「更新履歴」に日付と版番号を添えて残り続ける。
//   流れているうちに読み逃した人が、あとから辿れるようにするため。
export const TICKER_COUNT = 2;

// ★ 遊ぶ人が触れないものを書かないこと。
//   ペット(試験中)は管理者モードでしか開けないので、8種目の鳥を
//   足した話をここに流しても、読んだ人は確かめようがない。
//   ペットを一般に開いた日に、まとめて1件書く。
//
// 新しいものを上に足していく。
export const CHANGES: ChangeNote[] = [
  {
    date: '2026-08-22',
    version: '0.143.1',
    text: '🖱 画面上の知らせ(紫の帯)が出ている約3秒のあいだ、'
      + '「発見図鑑」「説明書」「⚙設定」のタブが押せなくなっていた'
      + '不具合を直しました。知らせが上に重なってクリックを'
      + '吸い取っていたためです',
  },
  {
    date: '2026-08-22',
    version: '0.143.0',
    text: '👑 最深部の報酬と発見図鑑の報酬で、すでに持っている魔法と'
      + '同じ構成を引き当てると、同じ名前の魔法が2本に分かれてしまう'
      + '不具合を直しました。これからは持っていない構成が先に選ばれ、'
      + 'それでも重なった時は増やさずに強化され、品質も上がります',
  },
  {
    date: '2026-08-21',
    version: '0.142.1',
    text: '🔊 設定の音量つまみが保存されないことがある不具合を直しました。'
      + '音の素材の読み込みが遅い時につまみが効かなくなっており、'
      + '動かしても元に戻っていました。'
      + '新しい版を出した直後ほど起きやすい状態でした',
  },
  {
    date: '2026-08-21',
    version: '0.142.0',
    text: '🥚 持てる卵を6個から10個に増やしました。'
      + 'あわせて鳥のカードの「〇〇と交配」は、'
      + '今すぐ組める相手のぶんだけ出るようにしました。'
      + 'これまでは押せない相手も並んでいたので、'
      + '交配所の預かりが増えるほど押せる相手が埋もれていました',
  },
  {
    date: '2026-08-21',
    version: '0.141.1',
    text: '⏳ 魔法の再使用時間が、光る残量バーで見えるようになりました。'
      + 'これまでは暗い帯を薄く重ねていたため、'
      + '封印のように40秒近く待つ魔法だと止まって見えて、'
      + 'あとどれくらいで撃てるのか分かりませんでした',
  },
  {
    date: '2026-08-21',
    version: '0.141.0',
    text: '🔥 継続ダメージ(延焼)にも属性の相性が効くようになりました。'
      + 'これまでは着弾の一撃だけが「耐性」で弱まり、'
      + 'じわじわ削るぶんは相手の耐性をすり抜けて満額入っていました。'
      + '弱点の相手には逆に、継続ダメージも大きくなります',
  },
  {
    date: '2026-08-18',
    version: '0.140.1',
    text: '🔌 共闘中に通信が切れた時、復帰をあきらめるまでを90秒から4分に延ばしました。'
      + 'サーバーが切断に気づくのが遅れると、席が空く直前に'
      + 'あきらめてしまうことがありました',
  },
  {
    date: '2026-08-17',
    version: '0.140.0',
    text: '🛡 同じ端末なのに「別の端末に新しい記録があります」と出て、'
      + '取り込むと進行が巻き戻ってしまう不具合を直しました。'
      + '到達ステージなどが後退する保存は、サーバーが止めるようにしています',
  },
  {
    date: '2026-08-15',
    version: '0.139.0',
    text: '🥚 ペットの枠を「鳥」と「卵」で別々にしました。鳥6羽 + 卵6個まで持てます。'
      + 'ボスの卵も交配のお礼の卵も、鳥を育てているせいで取り逃すことが'
      + 'なくなりました(ただし鳥がいっぱいだと卵は孵りません)',
  },
  {
    date: '2026-08-15',
    version: '0.138.0',
    text: '🥚 交配所へ預けたままでも交配を仕掛けられるようになりました。'
      + '別々の研究者が♂と♀を預けている時も、どちらかが押せば成立します'
      + '(引き取る必要はありません)',
  },
  {
    date: '2026-08-15',
    version: '0.137.9',
    text: '🎉 ボスを倒すと、称賛のコメントが画面を流れるようになりました。'
      + '同じ部屋の全員に同じコメントが流れ、一緒に戦った研究者の名前も出ます',
  },
  {
    date: '2026-08-15',
    version: '0.137.7',
    text: '📖 説明書の誤りを直しました。'
      + 'エレメント表の雷・光・闇が「MP+4」と書かれていて'
      + '"MPが増える"に読めましたが、正しくは"消費MPが重くなる"です。'
      + 'また、戦闘に持ち込める魔法はボス撃破で4本→6本まで増えるのに'
      + '説明がありませんでした(ステージ10で5本目・20で6本目)',
  },
  {
    date: '2026-08-13',
    version: '0.137.0',
    text: '📊 研究室の魔導書に「魔導値合計」を出しました。'
      + '持っている魔法のうち強い順に、装備できる本数ぶんの合計です'
      + '(オンラインの順位はこの数字で競います)',
  },
  {
    date: '2026-08-13',
    version: '0.136.5',
    text: '🛠 ボス戦の途中でサーバーから切断されることがあった不具合を直しました。'
      + '部屋の計算が一度でも失敗するとサーバーごと落ちる作りになっていました',
  },
  {
    date: '2026-08-13',
    version: '0.136.0',
    text: '🔌 共闘で通信が切れた時、その理由を設定の「切断の記録」に残すようにしました。'
      + '落ちてしまった時は、この行を教えていただけると原因を絞れます',
  },
  {
    date: '2026-08-13',
    version: '0.135.3',
    text: '📖 魔導書の「魔導値順」が、出ている数字どおりに並んでいませんでした。'
      + '得意エレメントの上乗せぶんが並べ替えに入っておらず、直してあります',
  },
  {
    date: '2026-08-13',
    version: '0.135.0',
    text: '🐦 交配所へ預けた鳥は、なじむまで少し待つようになりました。'
      + '交配すると巣ができ、しばらくして卵になります',
  },
  {
    date: '2026-08-13',
    version: '0.134.0',
    text: '🐦 ペットが最大HP・MPに加えて、MPの自然回復も高めるようになりました。'
      + '毎秒+1、MP寄りの鳥なら+2になり、魔法を少し多く撃てます',
  },
  {
    date: '2026-08-11',
    version: '0.131.0',
    text: '🥚 卵を温められる間隔を20時間から11時間に縮めました。'
      + '朝と夜の2回でき、孵るまでが2.5日から1.4日になります',
  },
  {
    date: '2026-08-11',
    version: '0.129.0',
    text: '🐦 ペットが使えるようになりました。ボスを倒すと卵が手に入り'
      + '(5の倍数のステージ・その段では最初の1回だけ)、温めて孵すと鳥になります。'
      + '戦闘に連れて行くと最大HPと最大MPが上がります。詳しくは説明書へ',
  },
  {
    date: '2026-08-11',
    version: '0.123.0',
    text: '⛰️ 土が範囲攻撃になりました。1個混ぜるだけで隣の敵まで巻き込みます'
      + '(土2でさらに広く・土3で敵全体)。単体への威力は変わりません',
  },
  {
    date: '2026-08-11',
    version: '0.123.0',
    text: '💥 爆裂系(火×3)の爆発が、これまで隣の敵に届いていませんでした。'
      + '届く広さに直してあります',
  },
];

// 端末の日付を 'YYYY-MM-DD' で返す(Tips と同じ考え方)
function todayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// 帯に出すぶんだけを返す。新しい順に TICKER_COUNT 件。
//
// ★ 並べ替えは allChanges() に任せる。ここで別に並べ替えを書くと、
//   帯と更新履歴で順番が食い違う余地が残る。
// ★ 未来の日付は出さない。先の日付で書き置きした時に、まだ効いて
//   いない話が流れてしまう。
export function recentChanges(now = new Date()): ChangeNote[] {
  const key = todayKey(now);
  return allChanges()
    .filter(c => daysBetween(c.date, key) >= 0)
    .slice(0, TICKER_COUNT);
}

// 帯が流れる速さ(1秒あたりの画素数)。
//
// ★ 時間を固定にしてはいけない。translateX(-50%) を何秒でやるかを
//   決め打ちにすると、文が短い日はのろのろ、長い日は速く流れる。
//   同じ帯なのに日によって速さが変わるうえ、Tips のように
//   1文しか出ない日は極端に遅くなる(「遅い」と言われた原因)。
//   幅を測って、いつも同じ速さになるようにする。
export const TICKER_SPEED = 55;

// 中身の幅から流れる時間を決める。帯を組み立てた直後に呼ぶ。
export function fitTickerSpeed(track: HTMLElement | null): void {
  if (!track) return;
  // 同じ文を2つ並べてあるので、1周ぶんは全体の半分。
  const 幅 = track.scrollWidth / 2;
  if (幅 <= 0) return;
  track.style.animationDuration = `${Math.max(8, Math.round(幅 / TICKER_SPEED))}s`;
}

// これまでの変更点をすべて、新しい順に返す(設定の更新履歴で使う)。
//
// ★ 帯と違って日付で絞らない。古いものこそ、あとから見に来る値打ちがある。
export function allChanges(): ChangeNote[] {
  return CHANGES.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// 設定の「更新履歴」を組み立てる。
export function renderChangeHistory(): void {
  const box = document.querySelector('#change-history');
  if (!box) return;
  box.replaceChildren();
  const list = allChanges();
  if (list.length === 0) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'まだ記録がありません。';
    box.append(p);
    return;
  }
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'chg-row';
    const head = document.createElement('span');
    head.className = 'chg-when';
    head.textContent = `${c.date}  v${c.version}`;
    const body = document.createElement('span');
    body.className = 'chg-text';
    // ★ 手で書く文章なので textContent で入れる(記号が入っても壊れない)
    body.textContent = c.text;
    row.append(head, body);
    box.append(row);
  }
}

// 画面上部の流れる帯を作る。出すものが無ければ帯ごと隠す。
export function renderChanges(now = new Date()): void {
  const bar = document.querySelector('#changes-bar');
  if (!bar) return;
  const list = recentChanges(now);
  if (list.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  const text = `🆕 最近の変更点 ─ ${list.map(c => c.text).join('　／　')}`;
  // 同じ文を2つ並べて途切れずに流す(Tips と同じ作り)
  bar.innerHTML =
    `<div class="changes-track"><span></span><span></span></div>`;
  // ★ innerHTML に本文を差し込まないこと。変更点は手で書く文章なので、
  //   将来ここに記号や引用符が入っても壊れないよう textContent で入れる。
  for (const span of bar.querySelectorAll('span')) span.textContent = text;
  fitTickerSpeed(bar.querySelector('.changes-track'));
}
