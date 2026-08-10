# -*- coding: utf-8 -*-
"""Vidu用の人物参照画像を、FLUXで一人・一方向ずつ作る。"""

import argparse
import os
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cuts
import lineup
import vidu_cuts

OUT_DIR = HERE / 'ref_vidu'
ANGLES = {
    # ★ face は「顔のアップ」にしないこと。
    #   アップにすると瞳だけが極端に大きい別の顔が出て、全身の絵と
    #   同一人物に見えなくなった(蒼氷で発生・2026-08-11)。
    #   上半身までを入れると、全身と同じ描かれ方に寄る。
    'face': ('upper body portrait from the waist up, exact front view, '
             'looking directly at the viewer, the whole head fits inside the frame'),
    'front': ('full body from head to toe, exact front view, standing naturally, '
              'the whole character fits inside the frame with margin'),
    '45': ('full body from head to toe, turned 45 degrees to the side, '
           'the face is turned away from the viewer by 45 degrees, standing naturally, '
           'the whole character fits inside the frame with margin'),
    # ★ 「strict side profile at 90 degrees」だけでは真横にならない。
    #   6人とも45度程度で止まり、45の絵とほとんど同じになった(実測)。
    #   「片目しか見えない」「鼻の輪郭が横顔の線として見える」まで書く。
    'side': ('full body from head to toe, strict side profile, the character faces '
             'exactly to the left, seen from directly beside, only one eye is visible, '
             'the outline of the nose and chin reads as a profile silhouette, '
             'standing naturally, the whole character fits inside the frame with margin'),
}
PHOTO_RULES = (
    'plain flat neutral light grey background, shadowless uniform studio lighting, '
    'everything in sharp focus, no depth of field, no blur, vivid saturated colors, '
    'neutral relaxed pose, no action pose'
)

# ★ 「〜ではない」をここ(肯定側)に書いてはいけない。
#   尖った耳を止めようとして 'human ears, not elf ears' と書いたら、
#   モデルは否定語を読み飛ばして 'elf ears' だけを拾い、
#   6人全員・全アングルに尖った耳が生えた(2026-08-11に実測)。
#   消したいものは必ずネガティブ側へ。
REF_NEG = (cuts.NEG_STILL +
           ', elf ears, pointed ears, animal ears, '
           'multiple characters, cropped head, cut off limbs')


# ---- 個別の当て物 ----
#
# 特定の1枚だけが崩れる時に足す。全体のプロンプトをいじると、
# 通っている他の23枚まで巻き添えで変わってしまう。
#
# ★ 書き方の鉄則(2026-08-11に痛い目を見た)
#   足したいものだけを肯定文で書く。「〜ではない」は絶対に書かない。
#   モデルは否定語を読み飛ばして名詞だけ拾う。
#   消したいものは EXTRA_NEG(ネガティブ側)へ回すこと。
EXTRA_POS = {
    # つばの広い帽子で顔の向きが読めず、真横にならなかった。
    ('黒金', 'side'): 'the wide hat brim is tilted upward so that the sharp profile '
                      'of her face, nose and chin is clearly readable from the side',
    # 横から見た時だけ杖が斧のような形に化けた。杖の形を言い切る。
    ('紅蓮', 'side'): 'her weapon is a straight slender golden rod held upright, '
                      'with one single flame burning at the very top of the rod',
    # オーブが2つに見えた。数を言い切る。
    ('紫紺', '45'): 'exactly one single blue orb sits at the very top of the staff',
    ('紫紺', 'side'): 'exactly one single blue orb sits at the very top of the staff',
}

EXTRA_NEG = {
    ('紅蓮', 'side'): 'axe, blade, halberd, scythe, hammer',
    ('紫紺', '45'): 'two orbs, multiple orbs, second sphere',
    ('紫紺', 'side'): 'two orbs, multiple orbs, second sphere',
}


def prompt_for(name, angle):
    """台本の画風と人物記述へ、方向と参照画の作法だけを加える。"""
    extra = EXTRA_POS.get((name, angle))
    body = vidu_cuts.CHARS[name] + (f', {extra}' if extra else '')
    return f'{vidu_cuts.STYLE} {body}, {ANGLES[angle]}, {PHOTO_RULES}.'


def negative_for(name, angle):
    extra = EXTRA_NEG.get((name, angle))
    return REF_NEG + (f', {extra}' if extra else '')


def numbered_path(path):
    """既存画像を残し、必要なら末尾へ連番を付ける。"""
    if not path.exists():
        return path
    n = 2
    while True:
        candidate = path.with_name(f'{path.stem}_{n}{path.suffix}')
        if not candidate.exists():
            return candidate
        n += 1


def generate(names, takes, angles=None, seed_shift=0):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    made = []
    for name in names:
        for angle in (angles or list(ANGLES)):
            for take in range(1, takes + 1):
                print(f'▶ {name}／{angle}　案{take}を生成')
                seed = (sum(ord(c) for c in name + angle) * 1009
                        + take * 7919 + seed_shift * 104729) % (2 ** 31)
                wf = cuts.still_workflow(prompt_for(name, angle), seed)
                wf['3']['inputs']['text'] = negative_for(name, angle)
                wf['4']['inputs']['width'] = 1024 if angle == 'face' else 704
                wf['4']['inputs']['height'] = 1024 if angle == 'face' else 1280
                hist, took = cuts.run(wf, f'{name}_{angle}', limit=300)
                for src in cuts.collect(hist, 'images'):
                    raw = OUT_DIR / f'_{name}_{angle}_元.png'
                    shutil.copyfile(src, raw)
                    dst = numbered_path(OUT_DIR / f'{name}_{angle}.png')
                    lineup.cutout(str(raw), str(dst))
                    raw.unlink(missing_ok=True)
                    made.append(dst)
                    print(f'   {took:.0f}秒　保存: {dst.name}')
    make_contact_sheet()
    return made


def make_contact_sheet():
    """基本名24枚を、人物が行・方向が列の確認画像へまとめる。"""
    from PIL import Image, ImageDraw
    names = list(vidu_cuts.CHARS)
    cell_w, cell_h, label_h = 320, 320, 34
    sheet = Image.new('RGB', (cell_w * 4, (cell_h + label_h) * 6), (35, 35, 35))
    draw = ImageDraw.Draw(sheet)
    for row, name in enumerate(names):
        for col, angle in enumerate(ANGLES):
            path = OUT_DIR / f'{name}_{angle}.png'
            if path.exists():
                im = Image.open(path).convert('RGBA')
                im.thumbnail((cell_w - 12, cell_h - 12), Image.LANCZOS)
                x = col * cell_w + (cell_w - im.width) // 2
                y = row * (cell_h + label_h) + label_h + (cell_h - im.height) // 2
                sheet.paste(im, (x, y), im)
            draw.text((col * cell_w + 8, row * (cell_h + label_h) + 8),
                      f'{name} {angle}', fill='white')
    out = numbered_path(OUT_DIR / '_確認.png')
    sheet.save(out)
    print(f'✓ コンタクトシート: {out}')


def main():
    parser = argparse.ArgumentParser(description='Vidu用人物参照画像を作成します')
    parser.add_argument('name', nargs='?', help='一人だけ作る場合の名前')
    parser.add_argument('--takes', type=int, default=1, help='各方向の案数')
    parser.add_argument('--angle', help='方向を絞る(face / front / 45 / side)')
    parser.add_argument('--seed', type=int, default=0,
                        help='種をずらす。同じ指定で撮り直しても同じ絵しか出ない時に使う')
    parser.add_argument('--sheet-only', action='store_true',
                        help='生成せずコンタクトシートだけ組み直す')
    parser.add_argument('--dry-run', action='store_true', help='生成せずプロンプトだけ表示')
    args = parser.parse_args()
    if args.takes < 1:
        raise SystemExit('--takes は1以上を指定してください')
    if args.name and args.name not in vidu_cuts.CHARS:
        raise SystemExit(f'不明な名前です: {args.name}')
    if args.angle and args.angle not in ANGLES:
        raise SystemExit(f'不明な方向です: {args.angle}（{" / ".join(ANGLES)}）')
    names = [args.name] if args.name else list(vidu_cuts.CHARS)
    angles = [args.angle] if args.angle else list(ANGLES)
    if args.sheet_only:
        make_contact_sheet()
        return
    if args.dry_run:
        count = 0
        for name in names:
            for angle in angles:
                count += 1
                print(f'[{count:02d}] {name}_{angle}.png\n{prompt_for(name, angle)}')
                print(f'     ネガティブ: {negative_for(name, angle)}\n')
        print(f'合計: {count}種類（生成処理は行っていません）')
        return
    generate(names, args.takes, angles, args.seed)


if __name__ == '__main__':
    main()
