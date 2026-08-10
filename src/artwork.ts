// 画像素材の差し替え基盤
//
// public/img/manifest.json に置いたファイルを読み込み、
// 対応する画像があればそれを使い、無ければ今まで通り図形で描く。
// manifest.json 自体が無い場合も、何事もなく図形描画のまま動く。
//
// 置き場所と命名(すべて public/img/ の下・PNG推奨・背景は透過):
//   player.png          … プレイヤー(足元が下端・目安 高さ100px)
//   enemy/<形状>.png    … 敵14形状(blob/imp/golem/wisp/orb/beast/bird/plant/
//                          undead/knight/serpent/insect/eye/fish)
//   proj/<属性>.png     … 弾8種(fire/water/wind/earth/thunder/ice/light/dark)
//   bg/field.jpg        … 戦闘背景(960x540目安・透過不要なのでJPEG)
//
// ポーズ(あれば使う。無ければ待機の絵のまま):
//   player/1_cast.png / 1_release.png / 1_hurt.png
//   enemy/blob_cast.png …

import { Assets, Sprite, Texture } from 'pixi.js';
import type { ElementId } from '../shared/types';
import type { EnemyShape } from '../shared/data';
import { backgroundKeyForStage } from '../shared/data';
import { characterScale } from '../shared/characters';

// idle = 待機 / cast = 詠唱中 / release = 撃った・張った / hurt = 被弾
export type Pose = 'idle' | 'cast' | 'release' | 'hurt';
export const MOTION_POSES = ['cast', 'release', 'hurt'] as const;
export type MotionPose = typeof MOTION_POSES[number];

interface Manifest {
  players?: string[];   // 選択できるキャラクター(並び順が選択番号)
  player?: string;      // 旧形式(1体だけだった頃の素材)
  background?: string;      // 予備。backgrounds に無い時はこれを使う
  backgrounds?: Record<string, string>;  // ステージ段階ごと(S1〜S5 / B1〜B10)
  enemies?: Partial<Record<EnemyShape, string>>;
  projectiles?: Partial<Record<ElementId, string>>;
  playerPoses?: Partial<Record<MotionPose, string[]>>;
  enemyPoses?: Partial<Record<MotionPose, Partial<Record<EnemyShape, string>>>>;
}

const BASE = 'img/';
let manifest: Manifest | null = null;
const textures = new Map<string, Texture>();

function url(file: string): string {
  return `${BASE}${file}`;
}

// 起動時に1回だけ呼ぶ。素材が無くてもエラーにはしない。
export async function loadArtwork(): Promise<void> {
  try {
    const res = await fetch(url('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return;                       // 素材未導入 = 図形のまま
    manifest = await res.json() as Manifest;
  } catch {
    manifest = null;
    return;
  }

  const files: string[] = [];
  for (const f of manifest.players ?? []) if (f) files.push(f);
  if (manifest.player) files.push(manifest.player);
  if (manifest.background) files.push(manifest.background);
  for (const f of Object.values(manifest.backgrounds ?? {})) if (f) files.push(f);
  for (const f of Object.values(manifest.enemies ?? {})) if (f) files.push(f);
  for (const f of Object.values(manifest.projectiles ?? {})) if (f) files.push(f);

  await Promise.all(files.map(async f => {
    try {
      textures.set(f, await Assets.load(url(f)) as Texture);
    } catch {
      // 1枚欠けても他は使う(その形状だけ図形にフォールバック)
    }
  }));

  const n = textures.size;
  if (n > 0) console.log(`[素材] 画像を${n}枚読み込みました`);

  // ポーズの絵は待ってから始めない。
  //
  // ポーズは待機の3倍あるので、これも待つと起動が3倍遅くなる。
  // 揃うまでは待機の絵で動かし、読めた分から順に使う。
  // 回線の細い端末ほど恩恵が大きい(戦闘そのものは先に始められる)。
  void loadPoses();
}

async function loadPoses(): Promise<void> {
  const files: string[] = [];
  for (const pose of MOTION_POSES) {
    for (const f of manifest?.playerPoses?.[pose] ?? []) if (f) files.push(f);
    for (const f of Object.values(manifest?.enemyPoses?.[pose] ?? {})) {
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return;
  await Promise.all(files.map(async f => {
    try {
      textures.set(f, await Assets.load(url(f)) as Texture);
    } catch {
      // 1枚欠けても他は使う(その絵だけ待機のまま)
    }
  }));
  console.log(`[素材] ポーズの絵を${files.length}枚読み込みました`);
}

export function hasArtwork(): boolean {
  return textures.size > 0;
}

function make(file: string | undefined): Sprite | null {
  if (!file) return null;
  const tex = textures.get(file);
  return tex ? new Sprite(tex) : null;
}

// 高さを指定してスプライトを作る(足元が原点・左右中央)
function bottomAnchored(sp: Sprite, targetHeight: number): Sprite {
  const h = sp.texture.height || 1;
  const scale = targetHeight / h;
  sp.scale.set(scale);
  sp.anchor.set(0.5, 1); // 下端中央 = 地面に立つ
  return sp;
}

// プレイヤー画像(無ければ null)。charId は選択したキャラクターの番号。
// 帽子や杖など装飾の量がキャラごとに違うので、体格が揃って見えるよう
// キャラごとの倍率(characterScale)をかける。
export function playerArt(targetHeight = 100, charId = 0): Sprite | null {
  const list = manifest?.players;
  const file = list && list.length > 0
    ? list[Math.max(0, Math.min(list.length - 1, Math.floor(charId)))]
    : manifest?.player;
  const sp = make(file);
  return sp ? bottomAnchored(sp, targetHeight * characterScale(charId)) : null;
}

// 選択画面用: そのキャラの素材が読み込めているか
export function playerArtUrl(charId: number): string | null {
  const list = manifest?.players;
  if (!list || list.length === 0) return null;
  const file = list[Math.max(0, Math.min(list.length - 1, Math.floor(charId)))];
  return file ? url(file) : null;
}

// 敵画像(無ければ null)。targetHeight は形状ごとの高さ。
export function enemyArt(shape: EnemyShape, targetHeight: number): Sprite | null {
  const sp = make(manifest?.enemies?.[shape]);
  return sp ? bottomAnchored(sp, targetHeight) : null;
}

// ===== ポーズ =====
//
// 差し替えは Sprite の texture だけを入れ替えて行う(作り直さない)。
// 絵ごとに縦横比が違うので、入れ替えたら必ず倍率を計算し直すこと。
// これを忘れると、横に広いポーズだけキャラが大きく見える。

function clampIndex(list: string[], i: number): number {
  return Math.max(0, Math.min(list.length - 1, Math.floor(i)));
}

// そのポーズの絵。まだ読み込めていない・素材が無い場合は待機の絵を返す。
export function playerPoseTexture(charId: number, pose: Pose): Texture | null {
  if (pose !== 'idle') {
    const list = manifest?.playerPoses?.[pose];
    const tex = list && list.length > 0
      ? textures.get(list[clampIndex(list, charId)])
      : undefined;
    if (tex) return tex;
  }
  const base = manifest?.players;
  const file = base && base.length > 0
    ? base[clampIndex(base, charId)]
    : manifest?.player;
  return textures.get(file ?? '') ?? null;
}

export function enemyPoseTexture(shape: EnemyShape, pose: Pose): Texture | null {
  if (pose !== 'idle') {
    const tex = textures.get(manifest?.enemyPoses?.[pose]?.[shape] ?? '');
    if (tex) return tex;
  }
  return textures.get(manifest?.enemies?.[shape] ?? '') ?? null;
}

// スプライトを差し替える。高さは差し替え前と同じに保つ。
export function applyPoseTexture(
  sp: Sprite, tex: Texture | null, targetHeight: number,
): void {
  if (!tex || sp.texture === tex) return;
  sp.texture = tex;
  sp.scale.set(targetHeight / (tex.height || 1));
}

// 弾の画像(無ければ null)。中心基準。
export function projectileArt(attr: ElementId, size: number): Sprite | null {
  const sp = make(manifest?.projectiles?.[attr]);
  if (!sp) return null;
  const w = sp.texture.width || 1;
  sp.scale.set(size / w);
  sp.anchor.set(0.5);
  return sp;
}

// 戦闘背景(無ければ null)
//
// stage を渡すとその段階の背景を返す。素材が欠けていても落ちないよう、
// 「その段階 → 予備の1枚(background)」の順に落ちる。
// 素材を1枚も置いていない環境(manifest.example.json のまま)でも動くこと。
export function backgroundArt(
  width: number, height: number, stage?: number,
): Sprite | null {
  const key = stage === undefined ? null : backgroundKeyForStage(stage);
  const file = (key && manifest?.backgrounds?.[key]) || manifest?.background;
  const sp = make(file);
  if (!sp) return null;
  sp.width = width;
  sp.height = height;
  sp.anchor.set(0, 0);
  return sp;
}
