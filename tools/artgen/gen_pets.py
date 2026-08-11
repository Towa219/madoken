# 魔導研究記 ペット(鳥)の絵ジェネレータ
#
# ComfyUI(ローカル)で7種の鳥を生成し、背景を透過して public/img/pets/ に置く。
# 手順は gen.py の敵キャラとまったく同じなので、関数はそちらから借りる。
#
#   python gen_pets.py --only owl      … 1種だけ試す
#   python gen_pets.py --all           … 7種すべて
#   python gen_pets.py --manifest      … 生成せず manifest.json に登録するだけ
#
# ★ なぜ絵文字をやめたか。
#   最初は絵文字で出していたが、ヒバリとハトが同じ字(U+1F54A)で
#   画面上まったく見分けが付かず、ツバメには合う絵文字が無いので
#   ペンギンを当てるしかなかった。7種を描き分けるには絵を持つしかない。
#
# ★ 正面寄りで描かせる。真横にしてはいけない。
#   最初は敵キャラに倣って「from side, facing right」で作ったが、
#   フクロウの顔盤も、タカの鋭い目も、ハトの丸い胸も、真横からは
#   見えず、どれも同じ茶色い塊になった(実際に生成して確認)。
#   頭上に置くアイコンなので、敵の方を向いている必要もない。

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gen  # noqa: E402  ComfyUIとの通信・切り抜き・整形をそのまま使う

PETS_DIR = os.path.join(gen.IMG_DIR, 'pets')

# 出力の高さ。戦闘では30〜40pxで描くので、その約4倍を持っておく。
# 大きすぎると通信量が増えるだけで、小さいと拡大した時に滲む。
PET_HEIGHT = 160

# 共通の描き方。小さく描いても形が読めることを最優先にする。
#
# ★ 「小鳥」を素直に描かせると、どれも同じような茶色い塊になる。
#   種類ごとに 色 と 体つき と 姿勢 の3つを必ず変えて指定する。
STYLE = ('anime style, game asset, cel shading, crisp lineart, vivid colors, '
         'fantasy, chibi, cute, simple shape, readable silhouette')

VIEW = ('no humans, a single small bird, full body, front view, facing viewer, '
        'standing, wings folded, looking at viewer, bright even lighting')

# 鳥どうしが似ないための否定指定。
PET_NEGATIVE = (
    'multiple birds, flock, two birds, spread wings, outstretched wings, '
    'flying, wide wingspan, cage, branch, perch stand, nest, egg, '
    'human, hands, person, realistic photo, photorealistic'
)

# ★ 強調の括弧(term:1.4)は使わないこと。
#   フクロウで (huge round golden eyes:1.4) と (ear tufts:1.2) を付けたら、
#   目と耳が巨大な金の円盤になった(実際に生成して確認)。
#   種類を分けるのは「色」と「体つき」で足りる。強調は形を壊す。
# 'seed' は採用した1枚の種。--all で同じ絵を作り直せるようにしてある。
# 候補を見比べて選んだので、これを変えると別の鳥になる。
PETS = {
    'sparrow': {
        'seed': 7000,
        'name': 'スズメ',
        'prompt': ('sparrow, brown and beige feathers, black cheek patch, '
                   'cream white chest, round plump body, short beak, short tail'),
        'neg': 'penguin, owl, eagle, crow, white bird, long tail, crest',
    },
    'lark': {
        'seed': 8001,
        'name': 'ヒバリ',
        # ★ スズメと見分けが付かないので、冠羽と「黄色」で分ける。
        #   最初は「細身・長い脚・直立」で体つきを変えようとしたが、
        #   人型の絵が出た(実際に2枚出た)。鳥の形を壊す言葉は使わない。
        'prompt': ('lark, bright pale yellow feathers, brown streaks, '
                   'small pointed crest on head, small round bird, open beak singing'),
        'neg': ('penguin, owl, eagle, crow, black bird, white bird, brown bird, '
                'sparrow, humanoid, human body, long legs, tall figure, '
                'girl, woman, dress, standing person'),
    },
    'swallow': {
        'seed': 7101,
        'name': 'ツバメ',
        'prompt': ('swallow, navy blue back, white belly, red orange throat, '
                   'forked tail, slim sleek body, pointed wings'),
        'neg': 'penguin, owl, eagle, round body, plump, short tail, flightless, brown bird',
    },
    'owl': {
        'seed': 7303,
        'name': 'フクロウ',
        'prompt': ('owl, brown feathers, big round yellow eyes, pale round face, '
                   'small hooked beak, fluffy round body, ear tufts'),
        'neg': 'penguin, eagle, sparrow, small eyes, long beak, slim body, perch, pole, stand',
    },
    'hawk': {
        'seed': 7303,
        'name': 'タカ',
        'prompt': ('hawk, sharp hooked yellow beak, glaring yellow eyes, '
                   'brown feathers, cream barred chest, strong talons, proud stance'),
        'neg': 'penguin, owl, big round eyes, cute, plump, chick, tiny, black bird',
    },
    'dove': {
        'seed': 7803,
        'name': 'ハト',
        # ★ 白い鳥を白背景で描かせてはいけない。切り抜きが鳥ごと消す
        #   (実際に4枚とも消えた)。背景だけ色を変える。
        'bg': 'simple background, light green background, solo, even lighting',
        'prompt': ('dove, white feathers with soft gray shading, clear dark outline, '
                   'smooth round body, small head, pink feet, gentle calm eyes'),
        'neg': 'penguin, owl, eagle, brown bird, black bird, crest, dark feathers',
    },
    'crow': {
        'seed': 7202,
        'name': 'カラス',
        # ★ 真っ黒だとシルエットになり、暗い戦闘背景では消える。
        #   艶と目の光を入れて、黒の中に形が見えるようにする。
        'bg': 'simple background, light gray background, solo, even lighting',
        'prompt': ('crow, black feathers with bright blue purple iridescent sheen, '
                   'strong rim highlights, visible feather edges, white eye glint, '
                   'thick straight beak, sleek body'),
        'neg': ('penguin, owl, eagle, white bird, brown bird, hooked beak, crest, '
                'silhouette, flat black, pure black, backlit, bat wings'),
    },
}


def gen_pet(key, seed):
    p = PETS[key]
    print(f'ペット「{p["name"]}」を生成中…')
    prompt = f"{gen.QUALITY}, {STYLE}, {p['prompt']}, {VIEW}, {p.get('bg', gen.FLAT_BG)}"
    neg = f"{gen.NEGATIVE}, {PET_NEGATIVE}, {p['neg']}"
    img = gen.generate(prompt, 1024, 1024, seed, neg)
    cut = gen.cutout(img)
    gen.check_cutout(cut, f'pet:{key}')
    out = gen.fit_height(gen.recenter(gen.trim(cut)), PET_HEIGHT)
    gen.check_centered(out, f'pet:{key}')
    os.makedirs(PETS_DIR, exist_ok=True)
    return gen.save(out, f'pets/{key}.png')


def try_pet(key, count, seed0):
    """候補を並べて作る。採用する1枚を選ぶための下見。

    ★ 1枚ずつ当てにいくと時間がかかるうえ、上書きしてしまって
      「さっきのほうが良かった」に戻れない。候補は別の場所へ残す。
    """
    from PIL import Image
    p = PETS[key]
    outdir = os.path.join(HERE, '_pet_candidates')
    os.makedirs(outdir, exist_ok=True)
    prompt = f"{gen.QUALITY}, {STYLE}, {p['prompt']}, {VIEW}, {p.get('bg', gen.FLAT_BG)}"
    neg = f"{gen.NEGATIVE}, {PET_NEGATIVE}, {p['neg']}"
    imgs = []
    for i in range(count):
        seed = seed0 + i * 101
        print(f'  {p["name"]} 候補{i + 1}(種 {seed})…')
        cut = gen.cutout(gen.generate(prompt, 1024, 1024, seed, neg))
        img = gen.fit_height(gen.recenter(gen.trim(cut)), PET_HEIGHT)
        img.save(os.path.join(outdir, f'{key}_{i + 1}_{seed}.png'))
        imgs.append(img)
    # 並べた1枚も作る。見比べるのに開く手間を減らす。
    w = sum(im.width for im in imgs) + 10 * (len(imgs) - 1)
    sheet = Image.new('RGBA', (w, PET_HEIGHT), (24, 24, 40, 255))
    x = 0
    for im in imgs:
        sheet.alpha_composite(im, (x, 0)); x += im.width + 10
    path = os.path.join(outdir, f'_{key}_一覧.png')
    sheet.save(path)
    print(f'  候補を並べた: {path}')


def write_manifest():
    """置かれている鳥だけを manifest.json の pets へ登録する。

    ★ gen.py の write_manifest は他の絵しか見ないので、こちらは
      既にある manifest.json を読んで pets の欄だけ差し替える。
      作り直すと敵や背景の登録が消える。
    """
    import json
    path = os.path.join(gen.IMG_DIR, 'manifest.json')
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            m = json.load(f)
    pets = {k: f'pets/{k}.png' for k in PETS
            if os.path.exists(os.path.join(PETS_DIR, f'{k}.png'))}
    if pets:
        m['pets'] = pets
    else:
        m.pop('pets', None)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print(f'manifest.json を更新した(鳥 {len(pets)}種 / 全{len(PETS)}種)。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='sparrow / owl など')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--manifest', action='store_true',
                    help='生成せず manifest.json だけ作り直す')
    ap.add_argument('--seed', type=int, default=0, help='作り直したい時にずらす')
    ap.add_argument('--try', dest='tries', type=int, default=0,
                    help='採用せず候補をN枚作って並べる(下見用)')
    args = ap.parse_args()

    if args.manifest:
        write_manifest()
        return
    if args.tries:
        keys = [args.only] if args.only else list(PETS)
        for k in keys:
            try_pet(k, args.tries, args.seed + 7000)
        return
    if not args.only and not args.all:
        ap.error('--only か --all か --manifest を指定する')

    keys = [args.only] if args.only else list(PETS)
    for k in keys:
        if k not in PETS:
            ap.error(f'不明な鳥: {k}(使えるのは {", ".join(PETS)})')

    import time
    t0 = time.time()
    for i, k in enumerate(keys):
        gen_pet(k, args.seed + PETS[k].get('seed', 7000 + i * 13))
    write_manifest()
    print(f'完了({time.time() - t0:.1f}秒)。')


if __name__ == '__main__':
    main()
