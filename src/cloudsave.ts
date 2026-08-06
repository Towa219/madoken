// クラウドセーブ(サーバー側セーブ)
//
// ニックネームと「引き継ぎコード」(端末が持つ秘密ID)の組で本人確認する。
// パスワードもメールアドレスも不要で、コードを別の端末に入力すれば続きから遊べる。
//
// 送るのは魔法の性能を除いた軽い形。性能はレシピから再計算するので送る必要がない。

import { finalStats, spellDisplayName } from '../shared/spellcraft';
import type { GameState, Spell } from '../shared/types';
import { applyLoadedState, state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function apiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:2567' : '';
}

// ---- 送信用に絞り込む/戻す ----

interface SlimSpell {
  id: string; name: string; recipe: Spell['recipe'];
  discoveries: string[]; level: number; rarity: Spell['rarity'];
}

function toSlim(s: GameState): Record<string, unknown> {
  return {
    version: s.version,
    nickname: s.nickname,
    charId: s.charId,
    researchP: s.researchP,
    inventory: s.inventory,
    spells: s.spells.map<SlimSpell>(sp => ({
      id: sp.id, name: sp.name, recipe: sp.recipe,
      discoveries: sp.discoveries, level: sp.level, rarity: sp.rarity,
    })),
    equipped: s.equipped,
    // お気に入りの装備セットも一緒に運ぶ。
    // スマホとPCで同じセットを呼び出せないと、端末ごとに組み直すことになる。
    loadouts: s.loadouts,
    discovered: s.discovered,
    slots: s.slots,
    maxStage: s.maxStage,
    bestStage: s.bestStage,
    bossCleared: s.bossCleared,
    sortMode: s.sortMode,
    codexRewarded: s.codexRewarded,
    legendRewarded: s.legendRewarded,
    bossRewarded: s.bossRewarded,
  };
}

function fromSlim(raw: unknown): Partial<GameState> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const spells = Array.isArray(o.spells) ? o.spells as SlimSpell[] : [];
  return {
    ...(o as unknown as Partial<GameState>),
    spells: spells.map(sp => ({
      ...sp,
      stats: finalStats(sp.recipe ?? {}, sp.level ?? 0, sp.rarity ?? 'normal'),
    })) as Spell[],
  };
}

// ---- 保存 ----

let pushTimer: number | undefined;
let lastPushed = '';
export let lastSyncAt = 0;
export let syncing = false;

// 変更のたびに呼ばれる。まとめて数秒後に1回だけ送る。
export function scheduleCloudSave(): void {
  if (!state.nickname || !state.nickToken) return; // 未登録の間はローカルのみ
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void pushCloudSave(), 4000);
}

// force=true は「別の端末に新しい記録があると知らせたうえで、
// それでもこの端末を残すと本人が選んだ」場合だけ。
export async function pushCloudSave(force = false): Promise<boolean> {
  if (!state.nickname || !state.nickToken) return false;
  const body = JSON.stringify({
    name: state.nickname,
    token: state.nickToken,
    data: toSlim(state),
    savedAt: Date.now(),
    force,
  });
  if (body === lastPushed) return true; // 変化なし
  syncing = true;
  renderCloudStatus();
  try {
    const res = await fetch(`${apiBase()}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      setCloudMsg(data.error ?? 'クラウド保存に失敗した。', true);
      return false;
    }
    lastPushed = body;
    lastSyncAt = Date.now();
    rememberSynced(lastSyncAt);
    void submitMagicRanking();  // 魔法が変わったら順位も更新する
    return true;
  } catch {
    setCloudMsg('サーバーに接続できないため、この端末にのみ保存した。', true);
    return false;
  } finally {
    syncing = false;
    renderCloudStatus();
  }
}

// 魔導値ランキングへ登録する。
//
// 送るのはレシピ・強化Lv・品質だけで、魔導値そのものは送らない。
// 順位はサーバーが計算し直すので、こちらで偽っても効かない。
// 装備中の4つではなく持っている魔法をすべて送り、上位4つはサーバーが選ぶ。
export async function submitMagicRanking(): Promise<void> {
  if (!state.nickname || !state.nickToken) return;
  try {
    await fetch(`${apiBase()}/api/ranking/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.nickname,
        nickToken: state.nickToken,
        bossCleared: state.bossCleared,
        spells: state.spells.map(sp => ({
          name: spellDisplayName(sp),
          recipe: sp.recipe,
          level: sp.level,
          rarity: sp.rarity,
        })),
      }),
    });
  } catch {
    // 順位の登録に失敗してもゲームは続けられる
  }
}

// ---- 別の端末で進めたかどうかの判定 ----
//
// 同じニックネームをPCとスマホで使うと、片方で進めた記録がもう片方に
// 自動では入ってこない。サーバー側は「古いセーブでの上書き」を拒むので
// データは壊れないが、そのままだと拒まれ続けて先に進めなくなる。
// そこで接続時にサーバーの保存時刻を見て、こちらより新しければ知らせる。

const SYNC_KEY = 'madoken_synced_at';
// 時計のずれや保存の行き違いで誤検知しないよう、この差までは「同じ」とみなす
const SYNC_SLACK_MS = 60_000;

function rememberSynced(at: number): void {
  try { localStorage.setItem(SYNC_KEY, String(at)); } catch { /* 使えなくても続行 */ }
}

function lastSyncedAt(): number {
  try { return Number(localStorage.getItem(SYNC_KEY)) || 0; } catch { return 0; }
}

// サーバーの方が新しければ、その保存時刻を返す(そうでなければ null)
export async function cloudNewerThanHere(): Promise<number | null> {
  if (!state.nickname || !state.nickToken) return null;
  try {
    const res = await fetch(`${apiBase()}/api/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.nickname, token: state.nickToken }),
    });
    const data = await res.json() as { ok: boolean; savedAt?: number };
    if (!data.ok || !data.savedAt) return null;
    return data.savedAt > lastSyncedAt() + SYNC_SLACK_MS ? data.savedAt : null;
  } catch {
    return null;
  }
}

// 帯の「取り込む」から呼ぶ。今のニックネームでサーバーの記録を取り込む。
export async function pullMine(): Promise<string | null> {
  if (!state.nickname || !state.nickToken) return 'ニックネームが未登録です。';
  return await pullCloudSave(state.nickname, state.nickToken);
}

// ---- 復元 ----

export async function pullCloudSave(name: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase()}/api/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
    const data = await res.json() as {
      ok: boolean; error?: string; data?: unknown; savedAt?: number;
    };
    if (!data.ok) return data.error ?? '復元できなかった。';
    const loaded = fromSlim(data.data);
    loaded.nickname = name;
    loaded.nickToken = token;
    applyLoadedState(loaded);
    lastSyncAt = data.savedAt ?? Date.now();
    rememberSynced(lastSyncAt);
    return null;
  } catch {
    return 'サーバーに接続できなかった。';
  }
}

// キャラ初期化時にクラウド側も消す
export async function deleteCloudSave(): Promise<void> {
  const name = state.nickname;
  const token = state.nickToken;
  if (!name || !token) return;
  try {
    await fetch(`${apiBase()}/api/save/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch { /* 消せなくても致命的ではない */ }
  lastPushed = '';
  lastSyncAt = 0;
}

// ---- 画面表示 ----

let cloudMsg = '';
let cloudMsgErr = false;

function setCloudMsg(text: string, isError = false): void {
  cloudMsg = text;
  cloudMsgErr = isError;
  renderCloudStatus();
}

export function renderCloudStatus(): void {
  const box = document.querySelector('#cloud-status');
  if (!box) return;
  if (!state.nickname) {
    box.textContent = 'ニックネームを登録してオンラインに接続すると、'
      + 'セーブがサーバーにも保存され、別の端末で続きから遊べるようになる。';
    return;
  }
  const when = lastSyncAt
    ? new Date(lastSyncAt).toLocaleString('ja-JP')
    : 'まだ';
  box.textContent = syncing
    ? 'クラウドに保存中…'
    : (cloudMsg || `クラウド保存: ${when}${lastSyncAt ? '' : '保存していない'}`);
  (box as HTMLElement).style.color = cloudMsgErr ? '#ff9977' : '#88bbaa';
}

// 「ニックネーム / 引き継ぎコード」の1行を読み解く。
// 区切りは半角/全角スラッシュ・空白のどれでも受け付ける。
export function parseTransferCode(
  raw: string,
): { name: string; token: string; error?: string } {
  const line = raw.trim();
  if (!line) {
    return { name: '', token: '', error: '引き継ぎコードを貼り付けてください。' };
  }
  const m = /^(.+?)\s*[/／]\s*(.+)$/.exec(line);
  if (!m) {
    return {
      name: '', token: '',
      error: '「ニックネーム / 引き継ぎコード」の形式で貼り付けてください。',
    };
  }
  const name = m[1].trim();
  const token = m[2].trim();
  if (!name || !token) {
    return { name, token, error: 'ニックネームとコードの両方が必要です。' };
  }
  return { name, token };
}

// 引き継ぎコードの表示・復元フォームの初期化
export function initCloudUI(): void {
  const codeBox = $('#transfer-code');
  const showBtn = $('#btn-show-code');
  const copyBtn = $('#btn-copy-code');
  const restoreBtn = $('#btn-restore');

  showBtn.addEventListener('click', () => {
    if (!state.nickname) {
      setCloudMsg('先にニックネームを登録して接続してください。', true);
      return;
    }
    const shown = codeBox.dataset.shown === '1';
    codeBox.dataset.shown = shown ? '' : '1';
    codeBox.textContent = shown
      ? '••••••••••••'
      : `${state.nickname} / ${state.nickToken}`;
    showBtn.textContent = shown ? '引き継ぎコードを表示' : '隠す';
  });

  copyBtn.addEventListener('click', () => {
    if (!state.nickname) return;
    const text = `${state.nickname} / ${state.nickToken}`;
    void navigator.clipboard?.writeText(text)
      .then(() => setCloudMsg('引き継ぎコードをコピーした。他人に渡さないこと。'))
      .catch(() => setCloudMsg('コピーできなかった。表示して手で控えてください。', true));
  });

  restoreBtn.addEventListener('click', () => {
    const { name, token, error } = parseTransferCode(
      $<HTMLInputElement>('#restore-code').value,
    );
    if (error) {
      setCloudMsg(error, true);
      return;
    }
    if (restoreBtn.dataset.arm !== '1') {
      restoreBtn.dataset.arm = '1';
      restoreBtn.textContent = '本当に復元? (この端末のデータは消えます)';
      window.setTimeout(() => {
        restoreBtn.dataset.arm = '';
        restoreBtn.textContent = '復元する';
      }, 4000);
      return;
    }
    restoreBtn.dataset.arm = '';
    restoreBtn.textContent = '復元する';
    setCloudMsg('復元中…');
    void pullCloudSave(name, token).then(err => {
      setCloudMsg(err ?? `「${name}」のデータを復元した。`, Boolean(err));
    });
  });

  renderCloudStatus();
}
