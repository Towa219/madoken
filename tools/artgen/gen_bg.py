# -*- coding: utf-8 -*-
r"""戦闘の背景をステージ段階ごとに作る。

    D:/ComfyUI/python_embeded/python.exe tools/artgen/gen_bg.py --list
    D:/ComfyUI/python_embeded/python.exe tools/artgen/gen_bg.py S1
    D:/ComfyUI/python_embeded/python.exe tools/artgen/gen_bg.py           … 全部

出来るもの: public/img/bg/<名前>.jpg (960x540)

★ 背景は「引き立て役」に徹すること
  前景にはプレイヤー6人・敵・ボス10体・8色のエフェクトが乗る。
  色相はすでに一周使われているので、背景の色相をどれだけずらしても
  必ずどれかと当たる。分けるのは彩度と明度で行う。

    ・彩度は低く(平均35%以下)。鮮やかな魔法が必ず浮く
    ・明度は低め(平均20〜35%)。実際に前景を乗せて確かめた値。
      明るいと敵とエフェクトが背景に溶ける(59%で火と雷が消えた)
    ・地面(y=460以下)はさらに暗く落とす。キャラの足元が読めなくなるため

  作った絵がこの条件を満たしているかは check_bg.py が測る。

★ 生成は ComfyUI(FLUX.1 schnell)。夢宮ゆり・PVと同じ道具。
  FLUX は cfg 1.0 で動かすのでネガティブが効かない。
  「人を出すな」は届かないので、人を連想させる語を一切書かないこと。
"""

import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(PROJECT, 'tools', 'mv'))
import cuts  # noqa: E402  ComfyUI とのやりとりを使い回す

OUT_DIR = os.path.join(PROJECT, 'public', 'img', 'bg')
W, H = 960, 540
GROUND_Y = 460          # src/battle.ts と同じ。ここから下が地面

# ---- 絵柄 ----
#
# 2つ用意して見比べた結果、game(2Dゲーム調)を採用(2026-08-11)。
# キャラのちび絵となじみ、背景が主役を奪わない。
STYLE_FILM = (
    'stylized 3D animated film background art, painterly 3D render, '
    'hand painted textures, volumetric light, cinematic depth, '
    'wide establishing shot, no characters, no creatures, empty scenery')

STYLE_GAME = (
    'anime game background art, hand painted 2D illustration, '
    'soft cel shading, clean shapes, subtle gradients, '
    'wide side-view stage, no characters, no creatures, empty scenery')

STYLES = {'film': STYLE_FILM, 'game': STYLE_GAME}

# 全景に共通で効かせる約束。前景を食わないための指定。
COMMON = (
    'very dark scene, night, low key lighting, deep shadows everywhere, '
    'muted desaturated color palette, low saturation, restrained colors, '
    'the sky and the background are dark and dim, nothing is brightly lit, '
    'the lower third of the image is a dark flat ground plane in deep shadow, '
    'nothing bright or busy in the lower third, '
    'strong atmospheric haze in the distance, '
    'horizontal composition with the horizon around two thirds down')

# ★ 明るい背景にしてはいけない(2026-08-11の実測)。
#   最初は「夕暮れの遺跡」で作ったら明度59〜64%になり、
#   火と雷のエフェクトが背景の橙に完全に埋もれ、白い敵も溶けた。
#   もとの field.jpg は明度20%で、暗いからこそ前景が浮いていた。
#   題材にも「夕暮れ」「日の出」のような明るい語を使わないこと。

# 中央は暗く空けること。キャラと敵はここに立つ。
# S3・B10 は中央に明るい丸が出て、ちょうど立ち位置に重なった(2026-08-11)。
CENTER_CLEAR = ('the centre of the frame is dark and empty, '
                'the light comes from the upper left, '
                'no bright glowing object in the middle of the image')


# ---- 15枚の設計 ----
#
# scene … 何を描くか
# tone  … 色の芯。ボスは「そのボスの色の反対側」を選び、正面衝突を避ける
STAGES = {
    'S1': dict(seed=1101, tone='cold grey and faint dull ochre',
               scene='the ruins of an old stone outpost on a wide plain at night, '
                     'broken low walls and fallen pillars, dry grass, '
                     'distant flat horizon'),
    'S2': dict(seed=1202, tone='cold slate grey and deep teal',
               scene='a vast underground cavern hall, huge natural rock columns '
                     'reaching up into darkness, still black water pools, '
                     'faint light falling from a crack far above'),
    'S3': dict(seed=1366, tone='pale blue grey and dull steel',
               extra=CENTER_CLEAR,
               scene='a frozen corridor deep inside a glacier, thick ice walls '
                     'with cracks running through them, frozen fog on the floor, '
                     'dim light diffused through the ice'),
    'S4': dict(seed=1404, tone='dim violet grey and old bronze',
               scene='the inside of a colossal ruined mage tower, broken spiral '
                     'stonework spiralling upward, floating fragments of masonry '
                     'held in the air, faint drifting motes'),
    'S5': dict(seed=1577, tone='deep indigo and dark charcoal',
               extra='the broken stonework fills the lower half of the frame from '
                     'edge to edge, several large ruined arches and toppled columns '
                     'stand along it, faint violet nebula bands across the sky',
               scene='a vast shattered stone causeway floating in an endless night '
                     'sky at the edge of the world, more broken platforms drifting '
                     'at different heights around it'),

    # ボス。tone はそのボスの色と正面衝突しない側を選ぶ
    'B1': dict(seed=2101, tone='cold grey and dull steel blue',           # 魔導核(桃紫)
               scene='a circular stone ritual chamber, a plain empty dais in the '
                     'centre, tall bare walls, shafts of dim light from above'),
    'B2': dict(seed=2202, tone='warm sand and faded brown grey',          # 石の守護者(灰緑)
               scene='an enormous carved stone gate hall, thick square pillars, '
                     'heaped rubble along the walls, dust in the air'),
    'B3': dict(seed=2303, tone='cold blue grey and dark slate',           # 紅蓮竜(赤)
               scene='a black volcanic canyon after the fire has died, cooled '
                     'cracked lava rock, thin grey smoke, overcast dark sky'),
    'B4': dict(seed=2404, tone='dim brown grey and dull umber',           # 氷獄女王(淡青)
               scene='a ruined stone throne hall with a collapsed roof, bare '
                     'earth floor, heavy dark timber beams fallen across it'),
    'B5': dict(seed=2505, tone='deep blue grey and cold charcoal',        # 雷帝(黄)
               scene='a storm-lashed stone rampart high above dark clouds, '
                     'wet flagstones, heavy rain haze, no lightning'),
    'B6': dict(seed=2606, tone='dull rose grey and faded clay',           # 大地母神(緑)
               scene='a dried terraced basin of cracked pale earth, low broken '
                     'retaining walls, bare dead trees, dust haze'),
    'B7': dict(seed=2707, tone='dark slate and deep blue shadow',         # 光輝天使(白)
               scene='a vast dark cathedral interior at night, towering bare '
                     'stone arches, deep shadow, only faint moonlight'),
    'B8': dict(seed=2877, tone='pale bone grey and cold white',           # 深淵の主(暗紫)
               extra='tall jagged pale rock spires rise along both sides of the '
                     'frame, layered ridges recede into the haze behind them',
               scene='a cracked bone-white salt basin ringed by weathered stone '
                     'formations under a colourless overcast sky'),
    'B9': dict(seed=2909, tone='warm amber grey and dull copper',         # 星喰らい(濃青紫)
               scene='an ancient desert observatory in ruin at sunset, huge '
                     'broken stone rings and toppled sundial slabs, sand drifts'),
    'B10': dict(seed=3077, tone='cold neutral grey and dark steel',       # 終焉の魔導核(桃)
                extra=CENTER_CLEAR,
                scene='the empty core of a collapsed world, concentric rings of '
                      'broken grey stone floating in a still void, no colour'),
}


def prompt_for(key, style):
    d = STAGES[key]
    extra = d.get("extra")
    return (f'{STYLES[style]} {d["scene"]}, '
            f'color palette of {d["tone"]}, {COMMON}'
            + (f', {extra}' if extra else '') + '.')


# 狙いの数値。ここに入っていれば前景が必ず浮く。
TARGET_SAT = 0.30       # 彩度の平均
TARGET_VAL = 0.24       # 明度の平均(実測で決めた。もとの field.jpg は0.20)


def fit_tone(im):
    """彩度と明度を狙いの値へ寄せる。

    ★ プロンプトだけでは決まらない(2026-08-11)。
      「very dark」「low saturation」と書いても、題材によって
      明度が59%になったり20%になったりする。前景が浮くかどうかは
      この数値で決まるので、最後にこちらで揃える。
      絵の中の明暗の関係は保ったまま、全体を掛け算で寄せるだけにする。
    """
    import numpy as np
    from PIL import Image
    import colorsys
    a = np.asarray(im.convert('RGB'), dtype=np.float32) / 255.0
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    cur_s, cur_v = float(sat.mean()), float(mx.mean())

    # 明度は掛け算で寄せる(暗部を潰さないため上限を置く)
    kv = min(1.6, max(0.35, TARGET_VAL / max(cur_v, 1e-6)))
    a = np.clip(a * kv, 0, 1)

    # 彩度は灰色へ寄せる割合で調整
    grey = a.mean(axis=2, keepdims=True)
    ks = min(1.4, max(0.25, TARGET_SAT / max(cur_s, 1e-6)))
    a = np.clip(grey + (a - grey) * ks, 0, 1)

    return Image.fromarray((a * 255).astype('uint8'))


def darken_ground(im):
    """地面の帯を落とす。キャラの足元と影が読めるようにする。"""
    from PIL import Image, ImageDraw
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    top = GROUND_Y - 40
    for y in range(top, im.height):
        t = (y - top) / max(1, im.height - top)
        d.line([(0, y), (im.width, y)], fill=(6, 8, 16, int(150 * min(1.0, t * 1.4))))
    return Image.alpha_composite(im.convert('RGBA'), layer).convert('RGB')


def generate(keys, style, tag=''):
    from PIL import Image
    os.makedirs(OUT_DIR, exist_ok=True)
    for key in keys:
        print(f'▶ {key}{tag} を描く')
        wf = cuts.still_workflow(prompt_for(key, style), STAGES[key]['seed'])
        # FLUX は16の倍数が扱いやすい。544で描いて540へ詰める。
        wf['4']['inputs']['width'] = W
        wf['4']['inputs']['height'] = 544
        hist, took = cuts.run(wf, key, limit=300)
        for src in cuts.collect(hist, 'images'):
            im = Image.open(src).convert('RGB').resize((W, H), Image.LANCZOS)
            im = fit_tone(im)
            im = darken_ground(im)
            out = os.path.join(OUT_DIR, f'{key}{tag}.jpg')
            im.save(out, quality=92)
            print(f'   {took:.0f}秒  {out}')
            break


def main():
    ap = argparse.ArgumentParser(description='戦闘背景を作ります')
    ap.add_argument('keys', nargs='*', help='S1 B3 など。省略すると全部')
    ap.add_argument('--style', default='game', choices=list(STYLES),
                    help='絵柄(film=3Dアニメ調 / game=2Dゲーム調)')
    ap.add_argument('--tag', default='', help='出力名の末尾に付ける文字')
    ap.add_argument('--list', action='store_true', help='一覧とプロンプト')
    a = ap.parse_args()
    keys = a.keys or list(STAGES)
    for k in keys:
        if k not in STAGES:
            raise SystemExit(f'不明な名前です: {k}（{" ".join(STAGES)}）')
    if a.list:
        for k in keys:
            print(f'[{k}] 種{STAGES[k]["seed"]}\n{prompt_for(k, a.style)}\n')
        return
    generate(keys, a.style, a.tag)


if __name__ == '__main__':
    main()
