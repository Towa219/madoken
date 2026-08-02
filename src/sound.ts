// 音まわり(BGM・効果音)
//
// 画像と同じ考え方で、public/sound/manifest.json に登録されたものだけを鳴らす。
// manifest.json が無い・ファイルが無い場合は「無音のまま何事もなく動く」。
//
// ブラウザ特有の制約を、ここで吸収する:
//   ・最初のユーザー操作までは音を鳴らせない(自動再生がブロックされる)
//     → 初回のクリック/キー操作で初期化し、それまでの再生要求は覚えておく
//   ・音量設定は端末ごとの好みなので、セーブ(引き継ぎ)には入れず
//     localStorage に別で保存する
//
// 置き場所(すべて public/sound/ の下):
//   bgm/<場面>.mp3  … ロビー/戦闘/ボス/決闘
//   sfx/<名前>.mp3  … 効果音

const BASE = 'sound/';
const PREF_KEY = 'madoken_sound_v1';

export type BgmId = 'lobby' | 'battle' | 'boss' | 'duel';

interface Manifest {
  bgm?: Partial<Record<BgmId, string>>;
  sfx?: Record<string, string>;
}

interface Prefs {
  bgmVolume: number; // 0〜1
  sfxVolume: number;
  muted: boolean;
}

let manifest: Manifest | null = null;
let prefs: Prefs = { bgmVolume: 0.4, sfxVolume: 0.7, muted: false };

// ループの継ぎ目をなだらかにする秒数。
// 生成した曲は「曲として終わる」ので、頭と尻が音楽的につながらない。
// 前後を少しだけ絞ると、切り替わりの段差が目立たなくなる。
const LOOP_FADE = 0.9;
const LOOP_FADE_FLOOR = 0.2; // 完全に無音にはしない(途切れて聞こえるため)
let fadeTimer: number | undefined;

let ctx: AudioContext | null = null;
let sfxGain: GainNode | null = null;
const sfxBuffers = new Map<string, AudioBuffer>();

let bgmEl: HTMLAudioElement | null = null;
let currentBgm: BgmId | null = null;
let pendingBgm: BgmId | null = null; // 初回操作前に要求された分

const listeners: (() => void)[] = [];

function url(file: string): string {
  return `${BASE}${file}`;
}

// ---- 設定の保存・読み込み ----

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Partial<Prefs>;
    prefs = {
      bgmVolume: clamp01(o.bgmVolume ?? prefs.bgmVolume),
      sfxVolume: clamp01(o.sfxVolume ?? prefs.sfxVolume),
      muted: Boolean(o.muted),
    };
  } catch { /* 壊れていれば既定値のまま */ }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch { /* 保存できなくても再生には影響しない */ }
}

function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function soundPrefs(): Readonly<Prefs> {
  return prefs;
}

export function onSoundChange(fn: () => void): void {
  listeners.push(fn);
}

function notifySound(): void {
  for (const fn of listeners) fn();
}

export function setBgmVolume(v: number): void {
  prefs.bgmVolume = clamp01(v);
  applyVolumes();
  savePrefs();
  notifySound();
}

export function setSfxVolume(v: number): void {
  prefs.sfxVolume = clamp01(v);
  applyVolumes();
  savePrefs();
  notifySound();
}

export function setMuted(m: boolean): void {
  prefs.muted = m;
  if (m) stopAllSfxLoops(); // 鳴らしっぱなしの音は即座に止める
  applyVolumes();
  savePrefs();
  notifySound();
  // ミュート解除で、止まっていたBGMを鳴らし直す
  if (!m && currentBgm) void startBgmEl(currentBgm);
}

function applyVolumes(): void {
  if (sfxGain) sfxGain.gain.value = prefs.muted ? 0 : prefs.sfxVolume;
  if (bgmEl) bgmEl.volume = bgmVolumeNow();
}

// 今この瞬間のBGM音量。ループの前後だけ絞る。
function bgmVolumeNow(): number {
  const base = prefs.muted ? 0 : prefs.bgmVolume;
  if (!bgmEl || !Number.isFinite(bgmEl.duration) || bgmEl.duration <= 0) return base;
  const t = bgmEl.currentTime;
  const left = bgmEl.duration - t;
  let k = 1;
  if (left < LOOP_FADE) k = left / LOOP_FADE;
  else if (t < LOOP_FADE) k = t / LOOP_FADE;
  return base * Math.max(LOOP_FADE_FLOOR, Math.min(1, k));
}

// 再生中だけ音量を追従させる(timeupdate は間隔が粗くフェードが階段になる)
function startFadeWatch(): void {
  if (fadeTimer) window.clearInterval(fadeTimer);
  fadeTimer = window.setInterval(() => {
    if (!bgmEl || bgmEl.paused) return;
    bgmEl.volume = bgmVolumeNow();
  }, 50);
}

function stopFadeWatch(): void {
  if (fadeTimer) window.clearInterval(fadeTimer);
  fadeTimer = undefined;
}

// 素材が1つでもあるか(設定画面の案内に使う)
export function hasSound(): boolean {
  const m = manifest;
  if (!m) return false;
  return Object.keys(m.bgm ?? {}).length > 0 || Object.keys(m.sfx ?? {}).length > 0;
}

// ---- 起動 ----

// 起動時に1回だけ呼ぶ。素材が無くてもエラーにはしない。
export async function initSound(): Promise<void> {
  loadPrefs();
  try {
    const res = await fetch(url('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return;               // 素材未導入 = 無音のまま
    manifest = await res.json() as Manifest;
  } catch {
    manifest = null;
    return;
  }
  // 最初のユーザー操作で音を使えるようにする(自動再生の制限)
  const unlock = (): void => {
    void ensureCtx();
    for (const ev of ['pointerdown', 'keydown', 'click', 'touchstart'] as const) {
      window.removeEventListener(ev, unlock);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'click', 'touchstart'] as const) {
    window.addEventListener(ev, unlock);
  }
  notifySound();
}

async function ensureCtx(): Promise<boolean> {
  if (!manifest) return false;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      sfxGain = ctx.createGain();
      sfxGain.connect(ctx.destination);
    } catch {
      ctx = null;
      return false;
    }
  }
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* まだ操作されていない */ }
  }
  applyVolumes();
  // 初回操作前に要求されていたBGMをここで鳴らす
  if (pendingBgm) {
    const id = pendingBgm;
    pendingBgm = null;
    await startBgmEl(id);
  }
  return ctx.state === 'running';
}

// ---- BGM ----
//
// BGMは長いので、丸ごと展開せずに <audio> で流す(メモリと通信量の節約)。

export function playBgm(id: BgmId): void {
  if (!manifest?.bgm?.[id]) return;   // その場面の曲が無ければ何もしない
  if (currentBgm === id && bgmEl && !bgmEl.paused) return;
  currentBgm = id;
  if (!ctx || ctx.state !== 'running') {
    pendingBgm = id;                  // まだ操作されていない
    return;
  }
  void startBgmEl(id);
}

async function startBgmEl(id: BgmId): Promise<void> {
  const file = manifest?.bgm?.[id];
  if (!file) return;
  if (!bgmEl) {
    bgmEl = new Audio();
    bgmEl.loop = true;
    bgmEl.preload = 'auto';
  }
  const src = url(file);
  if (!bgmEl.src.endsWith(src)) bgmEl.src = src;
  bgmEl.volume = bgmVolumeNow();
  try {
    await bgmEl.play();
    startFadeWatch();
  } catch {
    // 再生を拒否された(操作前など)。次の操作でまた試す
    pendingBgm = id;
  }
}

export function stopBgm(): void {
  currentBgm = null;
  pendingBgm = null;
  stopFadeWatch();
  if (bgmEl) {
    bgmEl.pause();
    bgmEl.currentTime = 0;
  }
}

// ---- 効果音 ----
//
// 効果音は重なって鳴るので、展開済みの音を使い回す。

export function playSfx(name: string): void {
  const file = manifest?.sfx?.[name];
  if (!file) return;                  // その音が無ければ何もしない
  if (prefs.muted || prefs.sfxVolume <= 0) return;
  void playSfxAsync(file);
}

async function loadSfx(file: string): Promise<AudioBuffer | null> {
  if (!ctx) return null;
  const cached = sfxBuffers.get(file);
  if (cached) return cached;
  try {
    const res = await fetch(url(file));
    if (!res.ok) return null;
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    sfxBuffers.set(file, buf);
    return buf;
  } catch {
    return null; // 1つ読めなくても他は鳴る
  }
}

async function playSfxAsync(file: string): Promise<void> {
  if (!(await ensureCtx()) || !ctx || !sfxGain) return;
  const buf = await loadSfx(file);
  if (!buf) return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(sfxGain);
    src.start();
  } catch { /* 鳴らせなくてもゲームは続く */ }
}

// ---- 鳴らしっぱなしの音(詠唱中・調合中など) ----
//
// 「〜している時の音」は始まりと終わりがあるので、単発とは別に管理する。
// 素材が無い場合は何も起きない(止める側も安全に空振りする)。

const loops = new Map<string, AudioBufferSourceNode>();
const loopWanted = new Set<string>(); // 読み込み待ちの間に止められた場合に使う

export function startSfxLoop(name: string): void {
  const file = manifest?.sfx?.[name];
  if (!file || loops.has(name) || loopWanted.has(name)) return;
  if (prefs.muted || prefs.sfxVolume <= 0) return;
  loopWanted.add(name);
  void (async () => {
    if (!(await ensureCtx()) || !ctx || !sfxGain) { loopWanted.delete(name); return; }
    const buf = await loadSfx(file);
    // 読み込んでいる間に止められていたら鳴らさない
    if (!buf || !loopWanted.has(name)) { loopWanted.delete(name); return; }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(sfxGain);
      src.start();
      loops.set(name, src);
    } catch { /* 鳴らせなくてもゲームは続く */ }
    loopWanted.delete(name);
  })();
}

export function stopSfxLoop(name: string): void {
  loopWanted.delete(name);
  const src = loops.get(name);
  if (!src) return;
  loops.delete(name);
  try { src.stop(); } catch { /* 既に止まっている */ }
}

// 画面を離れるときなどに、鳴りっぱなしを全部止める
export function stopAllSfxLoops(): void {
  for (const name of [...loops.keys()]) stopSfxLoop(name);
  loopWanted.clear();
}

// ---- 設定画面 ----

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

export function renderSoundUI(): void {
  const note = document.querySelector('#sound-note');
  if (!note) return;
  note.textContent = hasSound()
    ? 'BGMと効果音の音量を調整できる。'
    : '音の素材はまだ入っていない(現在は無音)。素材を入れると鳴るようになる。';

  const bgm = $<HTMLInputElement>('#bgm-volume');
  const sfx = $<HTMLInputElement>('#sfx-volume');
  bgm.value = String(Math.round(prefs.bgmVolume * 100));
  sfx.value = String(Math.round(prefs.sfxVolume * 100));
  bgm.disabled = prefs.muted;
  sfx.disabled = prefs.muted;
  $('#bgm-volume-val').textContent = prefs.muted ? '—' : `${bgm.value}%`;
  $('#sfx-volume-val').textContent = prefs.muted ? '—' : `${sfx.value}%`;

  const mute = $<HTMLButtonElement>('#btn-mute');
  mute.textContent = prefs.muted ? '🔇 ミュート中(押して解除)' : '🔈 ミュートする';
  mute.classList.toggle('muted', prefs.muted);
}

export function initSoundUI(): void {
  if (!document.querySelector('#sound-panel')) return;
  $<HTMLInputElement>('#bgm-volume').addEventListener('input', ev => {
    setBgmVolume(Number((ev.target as HTMLInputElement).value) / 100);
  });
  $<HTMLInputElement>('#sfx-volume').addEventListener('input', ev => {
    setSfxVolume(Number((ev.target as HTMLInputElement).value) / 100);
  });
  // つまみを離したときに、その音量で試聴できると分かりやすい
  $<HTMLInputElement>('#sfx-volume').addEventListener('change', () => playSfx('click'));
  $('#btn-mute').addEventListener('click', () => setMuted(!prefs.muted));
  onSoundChange(renderSoundUI);
  renderSoundUI();
}
