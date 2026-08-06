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
#
# ※ 必ず --shrink(減色)の前に測ること。減色すると肌の色がわずかに動き、
#   肌の判定から外れて数値が変わる(実際に 127px → 181px と食い違った)。

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

NAMES = ['黒金の魔女', '白銀の学士', '紅蓮の戦導士', '翠緑の薬導士', '紫紺の導師',
         '蒼氷の術士']
TOP = 0.40  # 顔を探す範囲(上から何割まで)


def eye_span(path):
    """両目の外端から外端までの幅を返す(全身の高さに対する割合も)。

    顔の大きさは目で測るのがいちばん当てになる。
    肌の幅は前髪・帽子・髭でいくらでも隠れ、髪込みの頭の幅は髪型の量で変わる。
    目の大きさと両目の間隔は絵柄が同じなら顔の大きさにそのまま比例する。

    探し方: 顔(肌)の枠の中で「肌でも白でもない暗い画素」がいちばん多い行を
    目の高さとみなし、その行の左端から右端までを測る。
    """
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(int)[:int(im.height * TOP)]
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    body = al > 128
    skin = (body & (r > 205) & (g > 160) & (g < 235)
            & (b > 140) & (b < 220) & (r > b + 20) & (r >= g))
    ys, xs = np.where(skin)
    if len(xs) == 0:
        return None, im.height
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())

    box = np.zeros_like(body)
    box[y0:y1 + 1, x0:x1 + 1] = True
    lum = (r + g + b) / 3
    dark = box & body & ~skin & (lum < 120)
    counts = dark.sum(axis=1)
    if counts.max() < 6:
        return None, im.height
    row = int(counts.argmax())
    # 目の高さの前後数行をまとめて見る(片目だけ拾うのを防ぐ)
    lo, hi = max(0, row - 4), min(dark.shape[0], row + 5)
    cols = np.where(dark[lo:hi].any(axis=0))[0]
    if len(cols) == 0:
        return None, im.height
    return int(cols[-1] - cols[0] + 1), im.height


def face_width(path):
    """(顔(肌)の幅, 頭(髪込み)の幅, 全身の高さ) を返す。

    見て感じる「頭の大きさ」は髪まで含めた頭全体なので、肌だけでは足りない。
    短髪の子は肌≒頭になり、長髪や帽子の子は肌がずっと小さく出るため、
    肌だけで比べると長髪の子ほど「頭が小さい」と誤って出る。

    頭の幅は「目の高さでの絵の横幅」で測る。
    その高さなら髪は入り、帽子のつばは上にあるので入らない。
    """
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(int)[:int(im.height * TOP)]
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    body = al > 128
    skin = (body & (r > 205) & (g > 160) & (g < 235)
            & (b > 140) & (b < 220) & (r > b + 20) & (r >= g))
    ys, xs = np.where(skin)
    if len(xs) == 0:
        return None, None, im.height
    face_w = int(xs.max() - xs.min() + 1)

    # 顔の縦の真ん中あたり(=目のあたり)の数行で、絵の横幅を測る
    y0, y1 = int(ys.min()), int(ys.max())
    mid = (y0 + y1) // 2
    lo = max(0, mid - 3)
    hi = min(body.shape[0], mid + 4)
    widths = []
    for y in range(lo, hi):
        cols = np.where(body[y])[0]
        if len(cols):
            widths.append(int(cols[-1] - cols[0] + 1))
    head_w = int(np.median(widths)) if widths else face_w
    return face_w, head_w, im.height


def main():
    print('キャラ         顔(肌)  頭(髪込み)  両目の幅  全身に対する両目の幅')
    ratios = []
    for i, name in enumerate(NAMES, start=1):
        path = os.path.join(IMG_DIR, 'player', f'{i}.png')
        if not os.path.exists(path):
            print(f'{name:12} 絵が無い')
            ratios.append(None)
            continue
        fw, hw, h = face_width(path)
        if fw is None:
            print(f'{name:12} 顔が見つからない')
            ratios.append(None)
            continue
        ew, _ = eye_span(path)
        if ew is None:
            ratios.append(hw / h)
            print(f'{name:12} {fw:4}px   {hw:4}px    目が拾えない')
            continue
        ratios.append(ew / h)
        print(f'{name:12} {fw:4}px   {hw:4}px    {ew:4}px   {ew / h:.1%}')

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
