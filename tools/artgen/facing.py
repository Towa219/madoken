# 味方の絵が右を向いているか左を向いているかを数で判定する。
#
# 目視だと何度も読み違えた(髪の流れ・杖を持つ手・尾の向きは当てにならない)。
# 斜め向きの絵では「頭の輪郭の中心」より「顔(肌)の中心」が、向いている側へ寄る。
# 後頭部と髪が反対側に張り出すぶん、必ずそうなる。
#
#   顔の中心 - 頭の中心 > 0  … 右を向いている(味方はこれが正解)
#   顔の中心 - 頭の中心 < 0  … 左を向いている
#
#   python facing.py            … 5体の待機を判定
#   python facing.py 1_cast.png … 1枚だけ判定(player/ の中の名前)

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
TOP = 0.40      # 頭を探す範囲(上から何割まで)
CLEAR = 0.04    # これ未満のずれは「ほぼ正面」として扱う


def facing(path):
    """(ずれの割合, 頭の幅) を返す。正なら右向き。"""
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(int)[:int(im.height * TOP)]
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]

    head = al > 128
    if not head.any():
        return None, 0
    skin = (head & (r > 205) & (g > 160) & (g < 235)
            & (b > 140) & (b < 220) & (r > b + 20) & (r >= g))
    if not skin.any():
        return None, 0

    hx = np.where(head.any(axis=0))[0]
    head_w = int(hx[-1] - hx[0] + 1)
    head_c = (int(hx[0]) + int(hx[-1])) / 2
    sx = np.where(skin.any(axis=0))[0]
    face_c = (int(sx[0]) + int(sx[-1])) / 2
    return (face_c - head_c) / head_w, head_w


def verdict(off):
    if off is None:
        return '判定できない(顔が見つからない)'
    if off > CLEAR:
        return f'右向き  (+{off:.0%})'
    if off < -CLEAR:
        return f'左向き  ({off:.0%})   ← 直す'
    return f'ほぼ正面 ({off:+.0%})'


def main():
    if len(sys.argv) > 1:
        for name in sys.argv[1:]:
            path = os.path.join(IMG_DIR, 'player', name)
            off, _ = facing(path)
            print(f'{name:16} {verdict(off)}')
        return

    print('味方の向き(顔の中心が頭の中心からどちらへ寄っているか)')
    print('正解は全員「右向き」。')
    for i, nm in enumerate(NAMES, start=1):
        for pose, label in [('', '待機'), ('_cast', '詠唱'),
                            ('_release', '発射'), ('_hurt', '被弾')]:
            path = os.path.join(IMG_DIR, 'player', f'{i}{pose}.png')
            if not os.path.exists(path):
                continue
            off, _ = facing(path)
            head = f'{nm}' if pose == '' else ''
            print(f'  {head:12} {label}  {verdict(off)}')


if __name__ == '__main__':
    main()
