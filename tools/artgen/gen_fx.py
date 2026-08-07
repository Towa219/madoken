# 演出用の光り物を作る(魔法陣・光の粒など)
#
# ガチャ演出のように、キャラでも敵でもない絵が要る時に使う。
# 光り物なので輪郭を持たず、キャラ用の切り抜き(rembg)は効かない。
# 黒背景で描かせ、明るさをそのまま不透明度にする(弾と同じやり方)。
#
#   python gen_fx.py --all
#   python gen_fx.py --only circle
#   python gen_fx.py --only circle --seed 1234
#
# 光の粒はここでは作らない。ただの丸いぼかしなので生成モデルを通すと
# かえって濁る(実際に一度作って暗い円になった)。粒は battle.ts と同じく
# Pixi の Graphics で描く。
#
# 出力: public/img/fx/
#
# 回して使う絵は「正面から見た真円・画面の中央」でないと、回した時に
# 中心がぶれる。プロンプトの先頭でそれを指定している(FLUX は向きの
# 指定を文の先頭に置かないと従わない)。

import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from gen import BLACK_BG, luma_cutout, save, trim  # noqa: E402
from gen_poses import generate  # noqa: E402

# 真上から見た平らな円であること。斜めから見た楕円になると回せない。
FLAT = ('a perfectly circular flat magic circle seen from directly above, '
        'straight top down view, not tilted, not in perspective, '
        'the circle is centered in the frame and fills most of it')
STYLE = ('anime game visual effect, glowing thin lines, bright neon glow, '
         'clean crisp linework, high contrast, no text, no letters, '
         'no characters, no people, no background scenery')

SUBJECTS = {
    'circle': {
        'out': 'fx/circle.png',
        'size': 1024,
        'seed': 5120,
        'prompt': (f'{FLAT}, an ornate arcane summoning circle made of '
                   'concentric rings, runic glyph bands and a star polygon '
                   'inside, glowing pale white and cyan light on pure black'),
    },
    'circle_inner': {
        'out': 'fx/circle_inner.png',
        'size': 1024,
        'seed': 5133,
        'prompt': (f'{FLAT}, a smaller simpler arcane circle, one thick ring '
                   'with short tick marks and a six pointed star inside, '
                   'glowing pale white light on pure black'),
    },
}

# 出力する大きさ。元の 1024 のまま置くと重い(回して使うので粗は目立たない)
OUT_SIZE = {'circle': 512, 'circle_inner': 384}


def gen_one(key, seed=None):
    s = SUBJECTS[key]
    print(f'演出「{key}」を生成中…')
    n = s['size']
    img = generate(f"{s['prompt']}, {BLACK_BG}, {STYLE}", n, n,
                   int(seed if seed is not None else s['seed']))
    cut = trim(luma_cutout(img), thresh=10)
    # 真円のまま置きたいので、縦横のうち長い方に合わせた正方形に収める
    side = max(cut.width, cut.height)
    from PIL import Image
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.alpha_composite(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
    out = OUT_SIZE.get(key, 512)
    sq = sq.resize((out, out), Image.LANCZOS)
    alpha = sq.split()[3]
    filled = sum(1 for v in alpha.getdata() if v > 8) / float(out * out)
    if filled < 0.05:
        print(f'  ※ 警告: {key} はほとんど透明(埋まり {filled:.1%})。'
              '暗すぎて切り抜きで消えている。seed を引き直すこと。')
    if filled > 0.85:
        print(f'  ※ 警告: {key} はほぼ全面が不透明(埋まり {filled:.1%})。'
              '黒背景が残っている恐れがある。')
    return save(sq, s['out'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help=f"{' / '.join(SUBJECTS)}")
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--seed', type=int)
    args = ap.parse_args()
    if not args.only and not args.all:
        ap.error('--only か --all を指定する')
    keys = [args.only] if args.only else list(SUBJECTS)
    for k in keys:
        if k not in SUBJECTS:
            ap.error(f'知らない演出: {k}')
    t0 = time.time()
    for k in keys:
        gen_one(k, args.seed)
    print(f'完了({len(keys)}枚 / {time.time() - t0:.1f}秒)。')


if __name__ == '__main__':
    main()
