# 味方5体の「顔の大きさ」を測って、表示倍率の目安を出す。
#
# 5体は同じ高さに縮小して表示されるので、頭身が違うと頭の大きさが揃わない。
# 目分量だと直すたびに揺れるので、数で見る。
#
# 測り方: 絵の上40%にある肌色の横幅を「顔の幅」とする。
#   ・下半分を入れると手足の肌を拾ってしまうので上だけを見る
#   ・帽子・フードには肌が無いので、被り物の大小に振り回されない
#
# ただし目安でしかない。前髪や髭で顔が隠れる子は小さめに出る
# (黒金の魔女は帽子と長い前髪、紫紺の導師は髭で顔が隠れる)。
# 出た倍率をそのまま入れず、指摘のあった子だけ半分ほど寄せるのが安全。
#
#   python head_size.py

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')
TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

NAMES = ['黒金の魔女', '白銀の学士', '紅蓮の戦導士', '翠緑の薬導士', '紫紺の導師']
TOP = 0.40  # 顔を探す範囲(上から何割まで)


def face_width(path):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(int)[:int(im.height * TOP)]
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    skin = ((al > 128) & (r > 205) & (g > 160) & (g < 235)
            & (b > 140) & (b < 220) & (r > b + 20) & (r >= g))
    xs = np.where(skin.any(axis=0))[0]
    if len(xs) == 0:
        return None, im.height
    return int(xs[-1] - xs[0] + 1), im.height


def main():
    print('キャラ         顔の幅   全身の高さに対する割合')
    ratios = []
    for i, name in enumerate(NAMES, start=1):
        path = os.path.join(IMG_DIR, 'player', f'{i}.png')
        if not os.path.exists(path):
            print(f'{name:12} 絵が無い')
            ratios.append(None)
            continue
        w, h = face_width(path)
        if w is None:
            print(f'{name:12} 顔が見つからない')
            ratios.append(None)
            continue
        ratios.append(w / h)
        print(f'{name:12} {w:4}px   {w / h:.1%}')

    got = [r for r in ratios if r]
    if not got:
        return
    mean = sum(got) / len(got)
    print()
    print(f'平均 {mean:.1%}。揃えるための倍率(そのまま入れず、目安として使う):')
    for name, r in zip(NAMES, ratios):
        if r:
            print(f'  {name:12} x{mean / r:.2f}')


if __name__ == '__main__':
    main()
