# 鳥がどちらを向いているかを測る。
#
#   python check_facing.py
#
# ★ 目で見て「全部右向き」と判断したら、スズメが左を向いていた
#   (2026-08-11、遊ぶ人に指摘されて気づいた)。8枚を並べて眺めると、
#   1枚だけ違っていても見落とす。数字で出す。
#
# どうやって向きを決めるか:
#   鳥の絵は「頭のほうが上に高く、尾のほうが下に長い」。
#   そこで上側の重心と下側の重心を比べる。上の重心が右に寄っていれば
#   頭が右 = 右向き。目や嘴を探すより頑丈で、種類ごとの差にも強い。

import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PETS_DIR = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'img', 'pets'))

BIRDS = [
    ('sparrow', 'スズメ'), ('lark', 'ヒバリ'), ('swallow', 'ツバメ'),
    ('owl', 'フクロウ'), ('hawk', 'タカ'), ('dove', 'ハト'),
    ('crow', 'カラス'), ('bluebird', 'アオイトリ'),
]


def facing(path):
    """右向きなら正、左向きなら負の値を返す。絶対値が大きいほどはっきり。"""
    a = np.array(Image.open(path).convert('RGBA'))
    al = a[..., 3] > 60
    ys, xs = np.nonzero(al)
    if len(xs) == 0:
        return 0.0, 0
    y0, y1 = ys.min(), ys.max()
    高さ = max(1, y1 - y0)
    上 = ys < y0 + 高さ * 0.40       # 頭のあたり
    下 = ys > y0 + 高さ * 0.60       # 胴と尾のあたり
    if 上.sum() < 20 or 下.sum() < 20:
        return 0.0, 0
    幅 = max(1, xs.max() - xs.min())
    ずれ = (xs[上].mean() - xs[下].mean()) / 幅
    return float(ずれ), int(幅)


def main():
    print('=== 鳥の向き ===')
    print(f'{"種類":<10}{"ずれ":>8}  判定')
    ng = []
    for key, name in BIRDS:
        p = os.path.join(PETS_DIR, f'{key}.png')
        if not os.path.exists(p):
            print(f'{name:<10}  ファイルが無い')
            continue
        ずれ, _ = facing(p)
        if ずれ > 0.03:
            判定 = '右向き'
        elif ずれ < -0.03:
            判定 = '左向き  ← 直す'
            ng.append(name)
        else:
            判定 = 'どちらとも言えない  ← 目で見る'
            ng.append(name)
        print(f'{name:<10}{ずれ:>+8.3f}  {判定}')

    print()
    if ng:
        print(f'=== {len(ng)}種が右を向いていない: {", ".join(ng)} ===')
        return 1
    print('=== 全種が右を向いている ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
