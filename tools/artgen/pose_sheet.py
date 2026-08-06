# ポーズを横一列に並べた一覧を作る(目視確認用)。
#
# 1行が1キャラ、左から 待機 / 詠唱 / 発射・防御 / 被弾。
# 「同じキャラに見えるか」「ポーズが見分けられるか」をまとめて確かめられる。
#
#   python pose_sheet.py            … tools/artgen/pose_sheet_味方.png と _敵.png
#   python pose_sheet.py 出力先.png … 1枚にまとめる

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')
TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

from PIL import Image, ImageDraw  # noqa: E402

CELL = 200
PAD = 10
LABEL = 18
BG = (34, 34, 48, 255)
GRID = (58, 58, 80, 255)
POSES = [('idle', '待機'), ('cast', '詠唱'), ('release', '発射・防御'), ('hurt', '被弾')]


def pose_path(base, pose):
    if pose == 'idle':
        return os.path.join(IMG_DIR, base.replace('/', os.sep))
    stem, ext = os.path.splitext(base)
    return os.path.join(IMG_DIR, f'{stem}_{pose}{ext}'.replace('/', os.sep))


def build(rows, out):
    """rows = [(表示名, 'player/1.png'), ...]"""
    w = len(POSES) * (CELL + PAD) + PAD
    h = len(rows) * (CELL + LABEL + PAD) + PAD + LABEL
    canvas = Image.new('RGBA', (w, h), BG)
    draw = ImageDraw.Draw(canvas)

    for c, (_, jp) in enumerate(POSES):
        draw.text((PAD + c * (CELL + PAD) + 4, 3), jp, fill=(255, 221, 102))

    for r, (name, base) in enumerate(rows):
        cy = PAD + LABEL + r * (CELL + LABEL + PAD)
        for c, (pose, _) in enumerate(POSES):
            cx = PAD + c * (CELL + PAD)
            draw.rectangle([cx, cy, cx + CELL, cy + CELL], outline=GRID)
            path = pose_path(base, pose)
            if not os.path.exists(path):
                draw.text((cx + 6, cy + CELL // 2), '(無し)', fill=(200, 120, 120))
                continue
            im = Image.open(path).convert('RGBA')
            s = min(CELL / im.width, CELL / im.height)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                           Image.LANCZOS)
            canvas.alpha_composite(
                im, (cx + (CELL - im.width) // 2, cy + CELL - im.height))
        draw.text((PAD + 4, cy + CELL + 3), name, fill=(220, 220, 240))

    canvas.convert('RGB').save(out)
    print(f'{out} に {len(rows)}体 × {len(POSES)}ポーズ をまとめた。')


def main():
    with open(os.path.join(HERE, 'subjects_flux.json'), encoding='utf-8') as f:
        subj = json.load(f)
    players = [(f"{i + 1}:{s.get('name', '')}", s['out'])
               for i, s in enumerate(subj['players'])]
    enemies = [(k, f'enemy/{k}.png') for k in subj['enemies']]

    if len(sys.argv) > 1:
        build(players + enemies, sys.argv[1])
        return
    build(players, os.path.join(HERE, 'pose_sheet_味方.png'))
    build(enemies, os.path.join(HERE, 'pose_sheet_敵.png'))


if __name__ == '__main__':
    main()
