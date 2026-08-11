// ペット画面(試験中・管理者モードでのみ開ける)。
//
// ★ 卵のうちは、何の鳥が生まれるか端末に届いていない。
//   サーバーが species を落として送ってくる(shared/pets.ts の maskPet)。
//   なので卵は必ず hint を見て描く。PET_SPECIES[pet.species] は
//   孵ったあとにしか使えない。
import {
  BREED_MAX_COUNT, MAX_PETS, PET_SPECIES, STAGE_NAME, WARM_INTERVAL_MS, bonusOf, breedLeft,
  breedWaitMs, canBreed, lifetimeMsOf, petDisplayName, stageOf, wireDisplayName,
} from '../shared/pets';
import type { EggHint, Pet, WirePet } from '../shared/pets';
import { adminKeyForRequest, isAdmin } from './admin';
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
    body: JSON.stringify({ key: adminKeyForRequest(), name: state.nickname, ...extra }),
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

function warmLeftOf(pet: WirePet, hint: EggHint): number {
  return Math.max(0, hint.warmNeeded - pet.warmCount);
}

function button(label: string, run: () => Promise<void>, disabled = false, title = ''): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = label; b.disabled = disabled; b.title = title;
  b.addEventListener('click', () => void run()); return b;
}

// ---------------------------------------------------------------- 孵化の場面
//
// 揺れる → ひびが入る → 光があふれる → 鳥が現れる → 名前を付ける。
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
  bird.textContent = sp.emoji;
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
    caption.textContent = `${sp.emoji} ${sp.name} が生まれた！`;
    await sleep(HATCH_MS.show);

    // ここで名前を付ける。空のまま決めれば種類名がそのまま名前になる。
    const form = document.createElement('div'); form.className = 'hatch-form';
    const label = document.createElement('p'); label.className = 'note';
    label.textContent = `${sp.note}　名前を付けてあげてください（全角8文字まで・空のままでも可）。`;
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 8; input.placeholder = sp.name;
    input.setAttribute('aria-label', 'ペットの名前');
    const ok = document.createElement('button'); ok.textContent = 'この子を迎える';
    form.append(label, input, ok); stageBox.append(form);
    input.focus();

    await new Promise<void>(resolve => {
      const done = () => { resolve(); };
      ok.addEventListener('click', done);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
    });

    const chosen = input.value.trim();
    if (chosen) {
      try { await call('rename', { petId: pet.id, petName: chosen }); }
      catch { /* 名前が付かなくても、生まれたことは変わらない */ }
    }
  } finally {
    veil.remove();
  }
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

const WATCH_INTERVAL_MS = 60 * 1000;
let watchTimer = 0;

function actionableCount(pets: WirePet[], board: WirePet[], now: number): number {
  let n = 0;
  for (const p of pets) {                       // 温められる卵
    if (p.hatchedAt <= 0 && !p.boarded && now - p.lastWarmAt >= WARM_INTERVAL_MS) n++;
  }
  // 交配。手持ちに空きが無ければ卵を受け取れないので、その時は数えない。
  if (pets.filter(p => !p.boarded).length < MAX_PETS) {
    const 相手 = board
      .map(grown)
      .filter((q): q is Pet => q !== null && q.ownerName !== state.nickname);
    for (const wp of pets) {
      const mine = grown(wp);
      if (!mine || mine.boarded) continue;
      if (相手.some(q => canBreed(mine, q, now) === null)) n++;
    }
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
  if (!isAdmin() || !state.nickname) { setBadge(0); return; }
  try {
    const data = await call('list');
    setBadge(actionableCount(data.pets ?? [], data.board ?? [], data.now ?? Date.now()));
  } catch { /* 繋がらない時は黙る。印が出ないだけで害は無い */ }
}

export function startPetWatch(): void {
  if (watchTimer) return;
  watchTimer = window.setInterval(() => { void refreshBadge(); }, WATCH_INTERVAL_MS);
  void refreshBadge();
}

// ---------------------------------------------------------------- 一覧

function eggCard(pet: WirePet, now: number): HTMLElement {
  const hint = pet.hint;
  const box = document.createElement('div'); box.className = 'panel';
  const h = document.createElement('h3');
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
  const allowed = pet.hatchedAt <= 0 && now - pet.lastWarmAt >= WARM_INTERVAL_MS;
  actions.append(button('温める', () => warmEgg(pet), !allowed,
    allowed ? '' : '前回から十分な時間が空いていません。'));
  if (!allowed) {
    const why = document.createElement('span'); why.className = 'note';
    why.textContent = ' まだ温められません。'; actions.append(why);
  }
  actions.append(button('手放す', async () => {
    if (confirm('この卵を手放しますか？')) await act('release', { petId: pet.id });
  }));
  box.append(actions); return box;
}

function petCard(pet: Pet, now: number, board: WirePet[]): HTMLElement {
  const sp = PET_SPECIES[pet.species]; const stage = stageOf(pet, now); const bonus = bonusOf(pet, now);
  const box = document.createElement('div'); box.className = 'panel';
  const h = document.createElement('h3');
  h.textContent = `${sp.emoji} ${petDisplayName(pet)}　${sp.name}・${pet.sex === 'm' ? '♂' : '♀'}`;
  if (pet.chosen) h.textContent += '　【連れている】';
  box.append(h);
  const info = document.createElement('p'); info.className = 'note';
  const remaining = stage === 'dead' ? '' : duration(pet.hatchedAt + lifetimeMsOf(pet) - now);
  info.textContent = `段階: ${STAGE_NAME[stage]}　HP +${bonus.hp} / MP +${bonus.mp}　${remaining}`;
  box.append(info);

  // 交配の残り。押してから断られるのでは遅いので、先に出しておく。
  if (stage === 'adult' || stage === 'elder') {
    const 待ち = breedWaitMs(pet, now);
    const b = document.createElement('p'); b.className = 'note';
    b.textContent = stage === 'elder'
      ? `交配: 年を取りすぎてもう産めない`
      : `交配: あと${breedLeft(pet)}回（一生に${BREED_MAX_COUNT}回まで）`
        + (待ち > 0 ? `　休み中 ${duration(待ち)}` : '');
    box.append(b);
  }

  const actions = document.createElement('div');
  actions.append(button(pet.chosen ? '連れているのをやめる' : '連れて行く',
    () => act('choose', { petId: pet.chosen ? '' : pet.id }), pet.boarded || stage === 'dead',
    pet.boarded ? '交配所へ預けている間は連れて行けません。' : stage === 'dead' ? 'もう天へ行ってしまいました。' : ''));
  actions.append(button('名前を変える', async () => {
    const value = prompt('新しい名前を入力してください（全角8文字まで）。', pet.name);
    if (value !== null) await act('rename', { petId: pet.id, petName: value });
  }));
  actions.append(button('手放す', async () => {
    if (confirm(`${petDisplayName(pet)}を手放しますか？`)) await act('release', { petId: pet.id });
  }));
  actions.append(button(pet.boarded ? '交配所から引き取る' : '交配所へ預ける',
    () => act(pet.boarded ? 'unboard' : 'board', { petId: pet.id })));
  if (!pet.boarded) {
    for (const wirePartner of board) {
      if (wirePartner.ownerName === state.nickname) continue;
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
  if (!isAdmin()) { msg.textContent = '管理者モードでのみ利用できます。'; return; }
  if (!state.nickname) { msg.textContent = '先にニックネームを決めてください。'; return; }
  msg.textContent = '読み込み中…';
  try {
    const data = await call('list');
    const pets = data.pets ?? []; const board = data.board ?? []; const now = data.now ?? Date.now();
    setBadge(actionableCount(pets, board, now));   // 同じ返事で印も直す
    const mineTitle = document.createElement('h3'); mineTitle.textContent = '手持ち'; list.append(mineTitle);
    if (!pets.length) {
      const empty = document.createElement('p'); empty.className = 'note';
      empty.textContent = 'まだペットはいません。'; list.append(empty);
    }
    for (const pet of pets) {
      const born = grown(pet);
      list.append(born ? petCard(born, now, board) : eggCard(pet, now));
    }
    const boardTitle = document.createElement('h3'); boardTitle.textContent = '交配所'; list.append(boardTitle);
    for (const pet of board) {
      const born = grown(pet);
      const p = document.createElement('p'); p.className = 'note';
      p.textContent = born
        ? `${PET_SPECIES[born.species].emoji} ${petDisplayName(born)}（${born.ownerName}） ${born.sex === 'm' ? '♂' : '♀'}・${STAGE_NAME[stageOf(born, now)]}`
        : `🥚 ${wireDisplayName(pet)}（${pet.ownerName}）・卵`;
      list.append(p);
    }
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
    id: 'demo', ownerName: state.nickname, species: sp.id, name: '', sex: 'f',
    hpGene: 50, mpGene: 50, lifeGene: 50, warmCount: sp.warmNeeded,
    lastWarmAt: 0, hatchedAt: 1, boarded: false, chosen: false,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: 0,
  }, undefined);
};
