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
//   bg/field.png        … 戦闘背景(1000x420目安)

import { Assets, Sprite, Texture } from 'pixi.js';
import type { ElementId } from '../shared/types';
import type { EnemyShape } from '../shared/data';

interface Manifest {
  player?: string;
  background?: string;
  enemies?: Partial<Record<EnemyShape, string>>;
  projectiles?: Partial<Record<ElementId, string>>;
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
  if (manifest.player) files.push(manifest.player);
  if (manifest.background) files.push(manifest.background);
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

// プレイヤー画像(無ければ null)
export function playerArt(targetHeight = 100): Sprite | null {
  const sp = make(manifest?.player);
  return sp ? bottomAnchored(sp, targetHeight) : null;
}

// 敵画像(無ければ null)。targetHeight は形状ごとの高さ。
export function enemyArt(shape: EnemyShape, targetHeight: number): Sprite | null {
  const sp = make(manifest?.enemies?.[shape]);
  return sp ? bottomAnchored(sp, targetHeight) : null;
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
export function backgroundArt(width: number, height: number): Sprite | null {
  const sp = make(manifest?.background);
  if (!sp) return null;
  sp.width = width;
  sp.height = height;
  sp.anchor.set(0, 0);
  return sp;
}
