// ペット画面。誰でも開ける(2026-08-11に一般公開)。
//
// ★ 卵のうちは、何の鳥が生まれるか端末に届いていない。
//   サーバーが species を落として送ってくる(shared/pets.ts の maskPet)。
//   なので卵は必ず hint を見て描く。PET_SPECIES[pet.species] は
//   孵ったあとにしか使えない。
import {
  BOARD_SETTLE_HOURS,
  BREED_MAX_COUNT, MAX_PETS, PET_SPECIES, PETS_PUBLIC, STAGE_NAME, WARM_INTERVAL_MS,
  bonusOf, boardSettleMs, breedLeft, countHeld,
  breedWaitMs, canBreed, chosenPetOf, isNest, lifetimeMsOf, nestLeftMs, petDisplayName, stageOf,
  wireDisplayName,
} from '../shared/pets';
import type { EggHint, Pet, WirePet } from '../shared/pets';
import { adminKeyForRequest, isAdmin } from './admin';
import { askConfirm } from './confirm';
import { petArtUrl, petScale } from './artwork';
import { playSfx } from './sound';
import { state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const apiBase = () => import.meta.env.DEV ? 'http://localhost:2567' : '';

interface PetReply {
  ok?: boolean; error?: string;
  pets?: WirePet[]; board?: WirePet[]; pet?: WirePet;
  hatched?: boolean; now?: number;
}

async function call(path: string, extra: Record<string, unknown> = {}): Promise<PetReply> {
  const res = await fetch(`${apiBase()}/api/pet/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: adminKeyForRequest(), name: state.nickname, token: state.nickToken, ...extra }),
  });
  const data = await res.json() as PetReply;
  if (!res.ok) throw new Error(data.error ?? '通信に失敗しました。');
  return data;
}

// 孵っているものだけ Pet として扱う。卵は species が無いので、
// stageOf や bonusOf のような「種類の表を引く」関数へ渡してはいけない。
function grown(pet: WirePet): Pet | null {
  return pet.species === null ? null : (pet as Pet);
}

function duration(ms: number): string {
  if (ms <= 0) return '時間になりました';
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours >= 24 ? `あと約${Math.ceil(hours / 24)}日` : `あと約${hours}時間`;
}

// 温められるまでの残り。分まで出す。
//
// ★ duration() は時間単位で切り上げるので、あと3分でも「あと約1時間」と
//   出てしまう。待っている人にはこの数分が知りたいところなので分けた。
function 残り時間文(ms: number): string {
  if (ms <= 0) return '温められます';
  const 全分 = Math.ceil(ms / 60000);
  if (全分 >= 60) {
    const 時 = Math.floor(全分 / 60);
    const 分 = 全分 % 60;
    return 分 === 0 ? `あと${時}時間` : `あと${時}時間${分}分`;
  }
  return `あと${全分}分`;
}

// ★ 端末の時計を当てにしない。孵化も寿命もサーバーの時計で数えているので、
//   端末の時計がずれていると残り時間だけ食い違う。
//   一覧を取った時に「サーバーの今」と「端末の今」の差を覚えておき、
//   数える時はその差を足す。
let 時計のずれ = 0;

function サーバーの今(): number {
  return Date.now() + 時計のずれ;
}

function warmLeftOf(pet: WirePet, hint: EggHint): number {
  return Math.max(0, hint.warmNeeded - pet.warmCount);
}

function button(label: string, run: () => Promise<void>, disabled = false, title = ''): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = label; b.disabled = disabled; b.title = title;
  b.addEventListener('click', () => void run()); return b;
}

// 鳥の絵。素材が無い環境では絵文字に落とす(他の絵と同じ考え方)。
function birdImg(species: string, size: number): HTMLElement {
  const src = petArtUrl(species);
  if (src) {
    const img = document.createElement('img');
    img.src = src; img.alt = '';
    img.className = 'pet-bird';
    img.style.height = `${Math.round(size * petScale(species))}px`;
    return img;
  }
  const span = document.createElement('span');
  span.className = 'pet-bird-emoji';
  span.style.fontSize = `${size}px`;
  span.textContent = PET_SPECIES[species as keyof typeof PET_SPECIES]?.emoji ?? '';
  return span;
}

// ---------------------------------------------------------------- 孵化の場面
//
// 揺れる → ひびが入る → 光があふれる → 鳥が現れる → 名前が決まる。
// 絵は用意せず、CSS の図形と絵文字だけで作る。素材が増えないぶん、
// あとから種類を足しても勝手に付いてくる。

const HATCH_MS = { shake: 1400, crack: 1200, burst: 900, show: 1100 };

function sleep(ms: number): Promise<void> {
  return new Promise(r => { setTimeout(r, ms); });
}

async function hatchScene(pet: Pet, hint: EggHint | undefined): Promise<void> {
  const sp = PET_SPECIES[pet.species];
  const veil = document.createElement('div'); veil.className = 'hatch-veil';
  const stageBox = document.createElement('div'); stageBox.className = 'hatch-stage';

  // 卵・光・鳥は同じ場所に重ねたいので、専用の枠(arena)の中だけを重ね置きにする。
  // 文字や入力欄まで重ね置きにすると、後から出る命名欄と字がぶつかる(実測で確認)。
  const arena = document.createElement('div'); arena.className = 'hatch-arena';

  const egg = document.createElement('div'); egg.className = 'hatch-egg';
  egg.style.background = hint?.shellCss ?? '#efe0c0';
  // ひび。幅0から広げて「割れていく」ように見せる。
  const crack = document.createElement('div'); crack.className = 'hatch-crack';
  egg.append(crack);

  const flash = document.createElement('div'); flash.className = 'hatch-flash';
  const bird = document.createElement('div'); bird.className = 'hatch-bird';
  bird.append(birdImg(pet.species, 110));
  const caption = document.createElement('p'); caption.className = 'hatch-caption';

  arena.append(egg, flash, bird);
  stageBox.append(arena, caption);
  veil.append(stageBox);
  document.body.append(veil);

  try {
    caption.textContent = '卵がひとりでに動いている…';
    egg.classList.add('is-shaking');
    await sleep(HATCH_MS.shake);

    caption.textContent = 'ひびが入った！';
    crack.classList.add('is-open');
    egg.classList.add('is-breaking');
    await sleep(HATCH_MS.crack);

    caption.textContent = '';
    flash.classList.add('is-burst');
    egg.classList.add('is-gone');
    await sleep(HATCH_MS.burst);

    bird.classList.add('is-here');
    // 生まれた種類の声を鳴らす。音の名前は種類の id に揃えてある
    // (tools/soundgen/gen_sfx.py の bird_*)。無ければ playSfx は黙る。
    playSfx(`bird_${pet.species}`);
    caption.textContent = `${sp.name} が生まれた！`;
    await sleep(HATCH_MS.show);

    // 名前はサーバーが決めて返してきている。ここでは知らせるだけ。
    //
    // ★ 入力させないこと。ペットの名前は交配所で他人にも見えるので、
    //   付けさせるとそこが不適切な名前の出口になる。
    const form = document.createElement('div'); form.className = 'hatch-form';
    const 名 = document.createElement('p'); 名.className = 'hatch-name';
    名.textContent = `名前は「${petDisplayName(pet)}」`;
    const label = document.createElement('p'); label.className = 'note';
    label.textContent = sp.note;
    const ok = document.createElement('button'); ok.textContent = 'この子を迎える';
    form.append(名, label, ok); stageBox.append(form);
    ok.focus();

    await new Promise<void>(resolve => {
      ok.addEventListener('click', () => { resolve(); });
    });
  } finally {
    veil.remove();
  }
}

// ---------------------------------------------------------------- 戦闘へ渡す
//
// 今どの1羽を連れているか。単騎の戦闘(src/battle.ts)がここを見る。
//
// ★ 戦闘に入るたびに通信しては駄目。開始が遅れるうえ、
//   合言葉を持たない人にも無駄な往復が出る。一覧を取った時に控える。
// ★ 共闘は別の道を通る。あちらはサーバーが持ち物を読んで最大HPに
//   足すので、端末の控えは使わない(改ざんできないようにするため)。

export interface BattlePet { species: string; hp: number; mp: number; regen: number }
let 連れている: BattlePet | null = null;

export function battlePet(): BattlePet | null {
  return 連れている;
}

function 控える(pets: WirePet[], now: number): void {
  const 孵った = pets.map(grown).filter((p): p is Pet => p !== null);
  const pet = chosenPetOf(孵った, now);
  連れている = pet ? { species: pet.species, ...bonusOf(pet, now) } : null;
}

// ---------------------------------------------------------------- タブの知らせ
//
// 「今できることがある」時だけ、タブに数字を出す。
//
// ★ 温めは20時間おきにしか進まない。気づかないと丸一日ぶん止まる。
//   時間で来るものなので、こちらから知らせないと取り返しがつかない。
// ★ 交配所は他人が動かす。自分が何もしなくても相手が増えるので、
//   開きっぱなしでも気づけるよう時々見に行く。
// ★ 押しても断られるものは数えない。手持ちが上限で卵を貰えない時や、
//   交配の回数を使い切った鳥しか居ない時は、印を出さない。

// 本人確認の2コマンドと手持ち一覧の1コマンドで1回3コマンドになるため、
// 5分間隔にして平均0.6コマンド/分まで抑える。
const WATCH_INTERVAL_MS = 5 * 60 * 1000;
let watchTimer = 0;

function actionableCount(pets: WirePet[], now: number): number {
  let n = 0;
  for (const p of pets) {                       // 温められる卵
    if (p.hatchedAt <= 0 && !p.boarded && !isNest(p, now)
      && now - p.lastWarmAt >= WARM_INTERVAL_MS) n++;
  }
  // 交配。手持ちに空きが無ければ卵を受け取れないので、その時は数えない。
  if (pets.filter(p => !p.boarded).length < MAX_PETS) {
    const grownPets = pets.map(grown).filter((p): p is Pet => p !== null && !p.boarded);
    let canPair = false;
    for (let i = 0; i < grownPets.length && !canPair; i++) {
      for (let j = i + 1; j < grownPets.length; j++) {
        if (canBreed(grownPets[i], grownPets[j], now) === null) { canPair = true; break; }
      }
    }
    if (canPair) n++;
  }
  return n;
}

function setBadge(n: number): void {
  const tab = document.querySelector('#tab-pet');
  if (!tab) return;
  if (n > 0) tab.setAttribute('data-badge', String(n));
  else tab.removeAttribute('data-badge');
}

async function refreshBadge(): Promise<void> {
  // 公開したら誰でも。それまでは管理者だけ。
  if (!(PETS_PUBLIC || isAdmin()) || !state.nickname) {
    setBadge(0); 連れている = null; return;
  }
  try {
    const data = await call('list', { board: false });
    const now = data.now ?? Date.now();
    時計のずれ = now - Date.now();
    控える(data.pets ?? [], now);
    const pets = data.pets ?? [];
    setBadge(actionableCount(pets, now));
    if (pets.length === 0 && watchTimer) { window.clearInterval(watchTimer); watchTimer = 0; }
  } catch { /* 繋がらない時は黙る。印が出ないだけで害は無い */ }
}

// 管理者になった直後など、すぐ取り直したい時に呼ぶ。
export function refreshPetCache(): void {
  void refreshBadge();
}

export function startPetWatch(): void {
  if (watchTimer) return;
  watchTimer = window.setInterval(() => { void refreshBadge(); }, WATCH_INTERVAL_MS);
  void refreshBadge();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (watchTimer) window.clearInterval(watchTimer);
    watchTimer = 0;
    return;
  }
  if (!watchTimer) {
    watchTimer = window.setInterval(() => { void refreshBadge(); }, WATCH_INTERVAL_MS);
    void refreshBadge();
  }
});

// ---------------------------------------------------------------- 一覧

// 卵の残り時間を数え直す手。一覧を描き直すたびに入れ替える。
//
// ★ 一覧を描くたびに積み上がると、古い卵のぶんまで動き続けて
//   だんだん重くなる。描き直しの先頭で必ず空にすること。
const 卵の見張り: { el: HTMLElement; 数える: () => void }[] = [];
let 卵タイマー = 0;

function 卵の時計を回す(): void {
  if (卵タイマー) return;
  卵タイマー = window.setInterval(() => {
    // 画面から消えたものは落とす(描き直しのたびに積み上がらないように)
    for (let i = 卵の見張り.length - 1; i >= 0; i--) {
      const w = 卵の見張り[i];
      if (!w.el.isConnected) { 卵の見張り.splice(i, 1); continue; }
      w.数える();
    }
  }, 30 * 1000);   // 30秒ごと。分の表示が1分ずれたまま残らないように
}

function eggCard(pet: WirePet, now: number): HTMLElement {
  const hint = pet.hint;
  const box = document.createElement('div'); box.className = 'panel';
  const h = document.createElement('h3');
  if (isNest(pet, now)) {
    // ★ ここで wireDisplayName をそのまま使わないこと。名前が無い時の
    //   既定が「たまご」なので、「たまご　巣」というちぐはぐな見出しになる
    //   (画面を撮って気づいた)。卵はまだ無い。
    const 名 = pet.name.trim();
    h.textContent = 名 ? `🪺 ${名}　巣` : '🪺 巣';
    box.append(h);
    const info = document.createElement('p'); info.className = 'note';
    const 数える = (): void => {
      const 残り = nestLeftMs(pet, サーバーの今());
      if (残り <= 0) { void renderPets(); return; }
      info.textContent = `卵ができるまで ${残り時間文(残り)}`;
    };
    数える();
    卵の見張り.push({ el: info, 数える });
    box.append(info);
    const actions = document.createElement('div');
    actions.append(button('手放す', async () => {
      const ok = await askConfirm({
        title: 'この巣を手放す?',
        body: 'まだ卵になっていません。一度手放すと戻せません。',
        yes: '手放す', danger: true,
      });
      if (ok) await act('release', { petId: pet.id });
    }));
    box.append(actions); return box;
  }
  h.textContent = `🥚 ${wireDisplayName(pet)}　まだ卵`;
  box.append(h);

  const info = document.createElement('p'); info.className = 'note';
  const left = hint ? warmLeftOf(pet, hint) : 1;
  info.textContent = hint
    ? `${hint.size}・殻は${hint.shell}・${hint.pattern}　孵化まで温めあと${left}回`
    : `孵化まで温めあと${left}回`;
  box.append(info);

  const guess = document.createElement('p'); guess.className = 'note';
  guess.textContent = '何の鳥かは、孵るまで分からない。';
  box.append(guess);

  const actions = document.createElement('div');
  // canWarm は Pet(species 必須)を取るので卵には使えない。同じ式をここで書く。
  const 次に温められる時刻 = pet.lastWarmAt + WARM_INTERVAL_MS;
  const allowed = pet.hatchedAt <= 0 && now >= 次に温められる時刻;
  const 温めボタン = button('温める', () => warmEgg(pet), !allowed,
    allowed ? '' : '前回から十分な時間が空いていません。');
  actions.append(温めボタン);

  // 残り時間。1分ごとに数え直す。
  //
  // ★ 描いた時の文字を貼るだけでは駄目。開いたまま待つ人には、
  //   何分経っても「あと3時間」のまま止まって見える。
  // ★ 数え終わったらボタンを自分で押せるようにする。
  //   通信し直さないと押せないのでは、待った意味が薄い。
  const 残り = document.createElement('span'); 残り.className = 'note egg-left';
  actions.append(残り);
  // ★ ここで isConnected を見てはいけない。初回は画面へ差し込む前に
  //   呼ぶので必ず素通りし、文字が空のままになる(実際にそうなった)。
  //   画面から消えたものを止めるのは、見張り側で行う。
  const 数える = (): void => {
    const 差 = 次に温められる時刻 - サーバーの今();
    if (差 > 0) {
      残り.textContent = ` 温められるまで ${残り時間文(差)}`;
      return;
    }
    残り.textContent = ' 温められます';
    温めボタン.disabled = false;
    温めボタン.title = '';
  };
  数える();
  if (!allowed) 卵の見張り.push({ el: 残り, 数える });
  actions.append(button('手放す', async () => {
    const ok = await askConfirm({
      title: 'この卵を手放す?',
      body: '何の鳥が生まれるかは分かりません。一度手放すと戻せません。',
      yes: '手放す', danger: true,
    });
    if (ok) await act('release', { petId: pet.id });
  }));
  box.append(actions); return box;
}

function petCard(pet: Pet, now: number, pets: WirePet[], board: WirePet[]): HTMLElement {
  const sp = PET_SPECIES[pet.species]; const stage = stageOf(pet, now); const bonus = bonusOf(pet, now);
  const box = document.createElement('div'); box.className = 'panel';
  const h = document.createElement('h3');
  h.className = 'pet-head';
  h.append(birdImg(pet.species, 34));
  const 見出し = document.createElement('span');
  見出し.textContent = `${petDisplayName(pet)}　${sp.name}・${pet.sex === 'm' ? '♂' : '♀'}`
    + (pet.chosen ? '　【連れている】' : '');
  h.append(見出し);
  box.append(h);
  const info = document.createElement('p'); info.className = 'note';
  const remaining = stage === 'dead' ? '' : duration(pet.hatchedAt + lifetimeMsOf(pet) - now);
  // ★ 「/秒」を必ず添える。「MP回復 +2」だけだと合計+2と読まれ、
  //   ほとんど無意味な数字に見えてしまう。効くのは毎秒のほう。
  const 回復 = bonus.regen > 0 ? ` / MP回復 +${bonus.regen}/秒` : '';
  info.textContent = `段階: ${STAGE_NAME[stage]}　HP +${bonus.hp} / MP +${bonus.mp}${回復}　${remaining}`;
  box.append(info);

  // 交配の残り。押してから断られるのでは遅いので、先に出しておく。
  if (stage === 'adult' || stage === 'elder') {
    const 待ち = breedWaitMs(pet, now);
    const b = document.createElement('p'); b.className = 'note';
    b.textContent = stage === 'elder'
      ? `交配: 年を取りすぎてもう産めない`
      : `交配: あと${breedLeft(pet)}回（一生に${BREED_MAX_COUNT}回まで）`
        + (待ち > 0 ? `　休み中 ${残り時間文(待ち)}` : '');
    box.append(b);
  }
  const なじみ = boardSettleMs(pet, now);
  if (なじみ > 0) {
    const b = document.createElement('p'); b.className = 'note';
    b.textContent = `なじむまで ${残り時間文(なじみ)}`;
    box.append(b);
  }

  const actions = document.createElement('div');
  actions.append(button(pet.chosen ? '連れていくのをやめる' : '連れて行く',
    () => act('choose', { petId: pet.chosen ? '' : pet.id }), pet.boarded || stage === 'dead',
    pet.boarded ? '交配所へ預けている間は連れて行けません。' : stage === 'dead' ? 'もう天へ行ってしまいました。' : ''));
  actions.append(button('手放す', async () => {
    const ok = await askConfirm({
      title: `${petDisplayName(pet)}を手放す?`,
      body: '一度手放すと戻せません。',
      yes: '手放す', danger: true,
    });
    if (ok) await act('release', { petId: pet.id });
  }));
  actions.append(button(pet.boarded ? '交配所から引き取る' : '交配所へ預ける', async () => {
    if (pet.boarded) { await act('unboard', { petId: pet.id }); return; }
    // ★ 預ける操作そのものが「他の人に使われてよい」という承諾になる。
    //   相手側のデータへ書き込む裏付けがこの承諾なので、必ずここで取る。
    const ok = await askConfirm({
      title: `${petDisplayName(pet)}を交配所へ預ける?`,
      body: '<b>他の研究者があなたの鳥と交配できるようになります。</b><br>'
        + 'そのたびに、あなたにもお礼の卵が1つ届きます。<br>'
        + '預けている間は戦闘に連れて行けません。いつでも引き取れます。',
      yes: '預ける',
    });
    if (ok) await act('board', { petId: pet.id });
  }));
  // ★ 預けている鳥からも仕掛けられる。
  //   以前は !pet.boarded の時だけ交配のボタンを出していた。そのため
  //   別々の人が♂と♀を預けると、どちらにもボタンが無く手詰まりになった
  //   (2026-08-15に指摘)。預けた側にお礼の卵が届く仕組みは元からあるので、
  //   預けたまま組めても筋は通る。
  {
    const partners = [...pets, ...board].filter((p, i, all) => all.findIndex(q => q.id === p.id) === i);
    for (const wirePartner of partners) {
      if (wirePartner.id === pet.id) continue;
      const partner = grown(wirePartner);
      if (!partner) continue;   // 相手が卵なら交配の相手にならない
      const reason = canBreed(pet, partner, now);
      actions.append(button(`${petDisplayName(partner)}と交配`,
        () => act('breed', { petId: pet.id, partnerId: partner.id }), Boolean(reason), reason ?? ''));
    }
  }
  box.append(actions); return box;
}

// 温めるのは特別扱い。孵った時だけ、画面いっぱいの場面へ入る。
async function warmEgg(pet: WirePet): Promise<void> {
  const msg = $('#pet-msg'); msg.textContent = '温めています…';
  try {
    const data = await call('warm', { petId: pet.id });
    if (data.hatched && data.pet) {
      const born = grown(data.pet);
      if (born) { msg.textContent = ''; await hatchScene(born, pet.hint); }
    } else {
      const hint = pet.hint;
      const left = data.pet && hint ? warmLeftOf(data.pet, hint) : 0;
      msg.textContent = `温めました。孵化まであと${left}回。`;
    }
    await renderPets();
  } catch (err) { msg.textContent = (err as Error).message; }
}

async function act(path: string, extra: Record<string, unknown>): Promise<void> {
  const msg = $('#pet-msg'); msg.textContent = '処理中…';
  try { await call(path, extra); msg.textContent = '完了しました。'; await renderPets(); }
  catch (err) { msg.textContent = (err as Error).message; }
}

export async function renderPets(): Promise<void> {
  const list = $('#pet-list'); const msg = $('#pet-msg'); list.replaceChildren();
  卵の見張り.length = 0;   // 前に描いたぶんの数え直しは捨てる
  卵の時計を回す();
  if (!(PETS_PUBLIC || isAdmin())) {
    msg.textContent = '管理者モードでのみ利用できます。'; return;
  }
  if (!state.nickname) { msg.textContent = '先にニックネームを決めてください。'; return; }
  msg.textContent = '読み込み中…';
  try {
    const data = await call('list');
    const pets = data.pets ?? []; const board = data.board ?? [];
    const now = data.now ?? Date.now();
    時計のずれ = now - Date.now();
    setBadge(actionableCount(pets, now));          // 同じ返事で印も直す
    控える(pets, now);                              // 戦闘へ渡す控えも直す
    // ★ 上限をいつでも見えるところに出す。
    //   押してから「手持ちが上限です」と断られるまで気づけなかった。
    //   卵も巣も1羽ぶんの枠を使うので、そのことも書いておく
    //   (「卵は数に入らない」と思われやすい。2026-08-15に指摘)。
    // ★ 数え方はサーバーと同じ countHeld を使う。ここで自前に数えると、
    //   画面は「まだ空きがある」と言うのにサーバーが断る、という食い違いが出る。
    //   卵は species を伏せて届くが、stageOf は hatchedAt<=0 を先に見て 'egg' を
    //   返すので、種類が無くても安全に数えられる。
    const 手持ち数 = countHeld(pets as unknown as Pet[], now);
    const mineTitle = document.createElement('h3');
    mineTitle.textContent = `手持ち ${手持ち数} / ${MAX_PETS}羽`;
    if (手持ち数 >= MAX_PETS) mineTitle.classList.add('pet-full');
    list.append(mineTitle);
    const 上限note = document.createElement('p');
    上限note.className = 手持ち数 >= MAX_PETS ? 'note pet-full' : 'note';
    上限note.textContent = 手持ち数 >= MAX_PETS
      ? `いっぱいです。これ以上は卵を受け取れません(ボスの卵も交配の卵も届きません)。`
        + `手放すか、交配所へ預けると空きます。`
      : `卵・巣も1羽として数えます。交配所へ預けている分は数に入りません。`;
    list.append(上限note);
    if (!pets.length) {
      const empty = document.createElement('p'); empty.className = 'note';
      empty.textContent = 'まだペットはいません。'; list.append(empty);
    }
    for (const pet of pets) {
      const born = grown(pet);
      list.append(born ? petCard(born, now, pets, board) : eggCard(pet, now));
    }
    // ===== 交配所 =====
    //
    // ★ 一覧を並べるだけでは、何をすればいいのか分からない。
    //   「♂と♀が居るのに何も起きない」と受け取られた(2026-08-15に指摘)。
    //   やり方と、1羽ごとの今の状態(組めるか・駄目ならなぜか)を書く。
    const boardTitle = document.createElement('h3');
    boardTitle.textContent = '交配所';
    list.append(boardTitle);

    const 手引き = document.createElement('p'); 手引き.className = 'note';
    手引き.innerHTML =
      'ここに預けられた鳥は、<b>他の研究者が交配の相手に選べます</b>。'
      + '<b>成立すると、預けた側にもお礼の卵が1つ届きます。</b><br>'
      + '交配するには <b>自分の鳥のカードにある「〇〇と交配」を押します</b>'
      + '（<b>交配所へ預けたままの自分の鳥からも押せます</b>ので、'
      + '引き取る必要はありません）。<br>'
      + `成立の条件は、二羽とも<b>成鳥</b>で、預けてから約${BOARD_SETTLE_HOURS}時間なじんでいて、`
      + `<b>一生${BREED_MAX_COUNT}回</b>の残りがあり、産んだ後の休憩が明けていること。`
      + '<b>押す側と相手の両方に手持ちの空きが要ります。</b>';
    list.append(手引き);

    if (!board.length) {
      const 空 = document.createElement('p'); 空.className = 'note';
      空.textContent = 'まだ誰も預けていません。'
        + '自分の鳥を預けると、他の研究者が交配してくれるかもしれません。';
      list.append(空);
    }

    // 自分の鳥のうち、相手になりうるもの(卵は除く)
    const 自分の成鳥 = pets.map(grown).filter((p): p is Pet => p !== null);

    for (const pet of board) {
      const born = grown(pet);
      const p = document.createElement('p'); p.className = 'note';
      if (!born) {
        p.textContent = `🥚 ${wireDisplayName(pet)}（${pet.ownerName}）・卵`;
        list.append(p); continue;
      }
      p.className = 'note pet-head';
      p.append(birdImg(born.species, 24));
      const t = document.createElement('span');

      // 1羽ごとの状態。「あと何回」「あと何時間」まで出す。
      const 段階 = stageOf(born, now);
      const 事情: string[] = [];
      if (段階 !== 'adult') {
        事情.push(段階 === 'elder' ? '年を取りすぎて産めない'
          : 段階 === 'dead' ? 'もう天へ行った' : 'まだ成鳥ではない');
      } else {
        const なじみ = boardSettleMs(born, now);
        const 休み = breedWaitMs(born, now);
        if (なじみ > 0) 事情.push(`なじむまで あと約${Math.ceil(なじみ / 3600000)}時間`);
        else if (休み > 0) 事情.push(`休んでいる あと約${Math.ceil(休み / 3600000)}時間`);
        else if (breedLeft(born) <= 0) 事情.push('もう産めない(回数を使い切った)');
        else 事情.push(`交配できる（あと${breedLeft(born)}回）`);
      }

      // 自分の鳥と組めるか。組めないなら、いちばん近い理由を出す。
      const 自分のもの = born.ownerName === state.nickname;
      let 組める合図 = '';
      if (段階 === 'adult') {
        const 相手候補 = 自分の成鳥.filter(m => m.id !== born.id);
        const 組める = 相手候補.filter(m => canBreed(m, born, now) === null);
        if (組める.length > 0) {
          組める合図 = `✔ あなたの${組める.map(petDisplayName).join('・')}と組めます`;
        } else if (!相手候補.length) {
          事情.push('あなたには組める鳥がいない');
        } else if (相手候補.every(m => m.sex === born.sex)) {
          事情.push('あなたの鳥とは同じ性別');
        } else {
          // 性別が合う相手のうち、いちばん近い理由を1つだけ出す
          const 異性 = 相手候補.filter(m => m.sex !== born.sex);
          const 理由 = canBreed(異性[0], born, now) ?? '';
          事情.push(理由.replace(/。$/, ''));
        }
      }

      t.textContent = `${petDisplayName(born)}（${born.ownerName}${自分のもの ? '＝あなた' : ''}） `
        + `${born.sex === 'm' ? '♂' : '♀'}・${STAGE_NAME[段階]}`
        + (事情.length ? ` ― ${事情.join(' / ')}` : '');
      p.append(t);
      if (組める合図) {
        // ★ ここだけ色を変える。一覧を眺めた時に「今すぐ押せる相手」が
        //   目に飛び込むようにするため。
        const 合図 = document.createElement('b');
        合図.className = 'pet-ready';
        合図.textContent = ` ${組める合図}`;
        p.append(合図);
      }
      list.append(p);
    }
    // ★ ここから下は管理者だけ。卵を無から出す・時間を飛ばす道具なので、
    //   公開後も一般には出さない(サーバーも合言葉で弾くが、押せるボタンが
    //   見えていること自体が不自然)。
    if (!isAdmin()) { msg.textContent = ''; return; }
    const tools = document.createElement('div'); tools.className = 'panel';
    const title = document.createElement('h3'); title.textContent = '管理者用'; tools.append(title);
    const stage = document.createElement('input');
    stage.type = 'number'; stage.value = '1'; stage.min = '1';
    stage.setAttribute('aria-label', 'ボスのステージ'); tools.append(stage);
    tools.append(button('卵を出す', () => act('grant', { stage: Number(stage.value) })));
    tools.append(button('+1日進める', () => act('advance', { days: 1 })));
    list.append(tools); msg.textContent = '';
  } catch (err) { msg.textContent = (err as Error).message; }
}

// 孵化の場面を単体で試すための入口(検証から呼ぶ)。
declare global {
  interface Window { __hatchDemo?: (species: string) => Promise<void> }
}
window.__hatchDemo = async (species: string) => {
  const sp = PET_SPECIES[species as Pet['species']] ?? PET_SPECIES.sparrow;
  await hatchScene({
    id: 'demo', ownerName: state.nickname, species: sp.id, name: 'ピピ', sex: 'f',
    hpGene: 50, mpGene: 50, lifeGene: 50, warmCount: sp.warmNeeded,
    lastWarmAt: 0, hatchedAt: 1, boarded: false, boardedAt: 0, eggAt: 0, chosen: false,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: 0,
  }, undefined);
};
