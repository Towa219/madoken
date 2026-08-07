# 6人を1人ずつ描いて、切り抜いて、横に並べた1枚を作る。
#
# なぜこうするか:
#   FLUX は「6人」と書いても数を合わせられない。実際に作らせたら
#   開幕は5人、合体は7〜8人になり、しかも全員が同じような黒フードの
#   別人になった(設定を無視する)。
#   1人ずつ描かせれば設定どおりに描かれるし、並べる数はこちらで決められる。
#
# 使い方:
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/lineup.py parts   … 1人ずつ描く
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/lineup.py build   … 切り抜いて並べる
#
# 切り抜きは ComfyUI 同梱の rembg(isnet-anime)を使う。

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cuts  # 絵柄・キャラ設定・ComfyUI とのやりとりを使い回す

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
PART_DIR = os.path.join(HERE, 'parts')

# 並べる順番。ゲームの選択画面と同じ並びにする。
ORDER = ['黒金', '白銀', '紅蓮', '翠緑', '紫紺', '蒼氷']

# 1人ずつ描く時の指定。
#   ・全身、正面、立ちポーズ(並べた時に向きがそろう)
#   ・平らな単色背景(切り抜きが効く。柄があると背景が残る)
POSE = ('full body from head to toe, standing upright facing the viewer, '
        'confident heroic pose, subtle magic glow around the hands, '
        'on a plain flat neutral grey background, even studio lighting, '
        'the whole character fits inside the frame with margin')


# 後ろ姿で、どの案を使うか。
# FLUX に「真後ろから」と書いても、こちらを振り向いた絵が混ざる。
# 2案ずつ描かせて、本当に背を向けている方を選んだ結果。
# 紅蓮だけ 3。案1・2はどちらも顔が見える斜め後ろで、
# Wan に渡すと振り向いて顔が崩れた。指定を強めて描き直した4案のうち、
# 顔が完全に隠れているのが案3。
BACK_PICKS = {'黒金': 2, '白銀': 1, '紅蓮': 3, '翠緑': 2, '紫紺': 1, '蒼氷': 1}


# 後ろ姿。合体・勝利のカットは「光を見上げる後ろ姿」なので、
# 正面の絵を暗くしても使えない(こちらを向いてしまう)。
# 顔は見えないので、帽子・マント・杖など輪郭で誰か分かるようにする。
# ★ 「真後ろから」だけでは足りない。顔が少しでも見える絵を渡すと、
#   Wan がその顔をつかんで振り向かせ、最後に崩す(実際に紅蓮で起きた)。
#   「後頭部しか見えない」「顔は完全に隠れている」まで言い切ること。
POSE_BACK = ('full body seen from directly behind, strict back view, '
             'standing upright with the back fully turned to the viewer, '
             'only the back of the head is visible, the face is completely hidden, '
             'not looking over the shoulder, head facing straight forward and away, '
             'on a plain flat neutral grey background, even studio lighting, '
             'the whole character fits inside the frame with margin')


def cmd_parts(variants=2, pose=None, tag=''):
    os.makedirs(PART_DIR, exist_ok=True)
    pose = pose or POSE
    for name in ORDER:
        print(f'▶ {name}{tag} を描く')
        for v in range(variants):
            seed = (abs(hash(name + 'lineup' + tag)) + v * 7717) % (2 ** 31)
            wf = cuts.still_workflow(f'{cuts.STYLE}, {cuts.CHARS[name]}, {pose}', seed)
            # 縦長にする。立ち姿は横に広い枠だと小さくしか描かれない。
            wf['4']['inputs']['width'] = 704
            wf['4']['inputs']['height'] = 1280
            hist, took = cuts.run(wf, name, limit=300)
            for p in cuts.collect(hist, 'images'):
                dst = os.path.join(PART_DIR, f'{name}{tag}_{v + 1}.png')
                import shutil
                shutil.copyfile(p, dst)
                print(f'   {took:.0f}秒  {dst}')


# rembg は ComfyUI 本体ではなく D:\ComfyUI\_tools に入っている(cp313ビルド)。
# python_embeded から使うには、そこを import の探し先に足す必要がある。
REMBG_PATH = os.environ.get('REMBG_PATH', r'D:\ComfyUI\_tools')


def cutout(src, dst):
    """背景を透過する。アニメ調の絵なので isnet-anime を使う。"""
    code = (
        'import sys\n'
        f'sys.path.insert(0, r"{REMBG_PATH}")\n'
        'from rembg import remove, new_session\n'
        'from PIL import Image\n'
        'im = Image.open(sys.argv[1]).convert("RGBA")\n'
        'out = remove(im, session=new_session("isnet-anime"))\n'
        'out.save(sys.argv[2])\n'
    )
    subprocess.run([sys.executable, '-c', code, src, dst], check=True)


def trim(im):
    """透明な余白を落とす。"""
    box = im.getbbox()
    return im.crop(box) if box else im


def unletterbox(im, thresh=18):
    """上下に入った黒帯を落とす。

    FLUX は「映画のような」と書くと勝手に黒帯を足すことがある。
    そのまま背景に使うと、並べた人物の足元に黒い線が残る。
    """
    g = im.convert('L')
    W, H = g.size
    rows = [max(g.crop((0, y, W, y + 1)).getdata()) for y in range(H)]
    top = 0
    while top < H and rows[top] < thresh:
        top += 1
    bottom = H
    while bottom > top and rows[bottom - 1] < thresh:
        bottom -= 1
    return im.crop((0, top, W, bottom)) if bottom - top > H * 0.5 else im


# 背景の指定。人を連想させる言葉を一切書かないこと(下の注記を参照)。
BG_LINEUP = (
    'stylized 3D animated film background art, empty ancient stone temple '
    'interior at dawn, tall carved columns, high vaulted ceiling, '
    'shafts of warm golden light from above, floating dust motes, '
    'cracked stone floor, weathered masonry, deserted architecture, '
    'painterly 3D render, deep depth of field, epic scale, wide shot')

BG_OPEN = (
    'stylized 3D animated film background art, enormous ancient stone doors '
    'standing open at the end of a vast dark temple corridor, blinding pale blue '
    'light pouring through the gap, tall carved columns on both sides, '
    'floating dust motes in the light shafts, empty cracked stone floor, '
    'painterly 3D render, strong backlight, epic scale, wide shot')

BG_CLIMAX = (
    'stylized 3D animated film background art, six glowing magic circles of '
    'different colors, yellow blue red green brown and pale cyan, stacked one '
    'above another and merging into a single enormous circle, a massive pillar '
    'of white light erupting upward through them, shockwave rings, '
    'empty dark ground at the bottom, no people, painterly 3D render, epic wide shot')

BG_VICTORY = (
    'stylized 3D animated film background art, a colossal stone guardian golem '
    'crumbling apart into glowing fragments that rise into a shaft of dawn light, '
    'falling rubble, settling dust, warm golden backlight, '
    'empty cracked ground at the bottom, no people, painterly 3D render, epic wide shot')

# ★ 最初は「巨人が立っているだけ」の背景に、正面向きの3人を並べていた。
#   敵が後ろにいるだけで、戦っている感じがまるで出なかった。
#   背景の側で「撃ち込まれている」状態にし、人物は後ろ姿にする。
BG_COOP = (
    'stylized 3D animated film background art, a colossal ancient stone guardian '
    'golem under attack in a ruined temple hall, staggering backward, '
    'a roaring stream of fire and jagged rock spikes and a spiral of green wind '
    'striking its chest and arms from the lower foreground, bursts of impact light, '
    'cracks glowing across its body, flying debris and dust, '
    'empty cracked stone floor in the near foreground, '
    'painterly 3D render, low angle, overwhelming scale, intense battle')


def cmd_build(picks=None, out=None, names=None, bg_prompt=None, bg_name='_背景',
              bg_seed=4242, height=0.62, darken=0.0, tag='', base=0.95):
    from PIL import Image
    picks = picks or (BACK_PICKS if tag == '_後' else {})
    names = names or ORDER
    bg_prompt = bg_prompt or BG_LINEUP
    out = out or os.path.join(cuts.STILL_DIR, '13_集合_1.png')
    W, H = cuts.W, cuts.H

    # 背景は別に描かせる。人物と一緒に描かせると、背景に引きずられて
    # 切り抜きが汚くなる。
    bg_path = os.path.join(PART_DIR, f'{bg_name}.png')
    if not os.path.exists(bg_path):
        print('▶ 背景を描く')
        # ★「人物なし」と書いても効かない。FLUX は cfg 1.0 で動かすので
        #   否定が届かず、実際に背景の真ん中へ巨大な顔が描き込まれた。
        #   人を連想させる言葉(mage/hero/party など)を一切書かず、
        #   建築だけを述べるのが確実。
        wf = cuts.still_workflow(bg_prompt, bg_seed)
        hist, _ = cuts.run(wf, '背景', limit=300)
        import shutil
        for p in cuts.collect(hist, 'images'):
            shutil.copyfile(p, bg_path)

    bg = unletterbox(Image.open(bg_path).convert('RGBA'))
    # 端に偽の文字(読めない英字)が紛れ込むことがある。周囲を少し落として消す。
    # FLUX は cfg 1.0 で否定が効かないので、描かせない方法が無く、切るのが確実。
    m = int(min(bg.width, bg.height) * 0.04)
    bg = bg.crop((m, m, bg.width - m, bg.height - m)).resize((W, H), Image.LANCZOS)

    # 1人ずつ切り抜いて、背丈をそろえて並べる
    figs = []
    for name in names:
        v = picks.get(name, 1)
        src = os.path.join(PART_DIR, f'{name}{tag}_{v}.png')
        if not os.path.exists(src):
            raise SystemExit(f'{src} が無い。先に parts を作ること')
        cut = os.path.join(PART_DIR, f'{name}{tag}_{v}_rgba.png')
        if not os.path.exists(cut):
            print(f'   切り抜き: {name}')
            cutout(src, cut)
        figs.append((name, trim(Image.open(cut).convert('RGBA'))))

    # 背丈をそろえる。全身の高さを画面の 62% に合わせる ―
    # 大きすぎると足が切れ、小さすぎると顔が見えない。
    target_h = int(H * height)
    scaled = []
    for name, im in figs:
        r = target_h / im.height
        scaled.append((name, im.resize((max(1, int(im.width * r)), target_h), Image.LANCZOS)))

    # 横に等間隔で置く。少し重ねて、集合写真らしく詰める。
    total = sum(im.width for _, im in scaled)
    gap = (W - total) / (len(scaled) + 1)
    x = gap
    base_y = int(H * base) - target_h        # 足元をそろえる
    from PIL import ImageDraw, ImageFilter
    for name, im in scaled:
        # 影を落とす。地面から浮いて見えるのを防ぐ。
        # 四角いままだと板を敷いたように見えるので、楕円にしてぼかす。
        sw, sh = int(im.width * 0.9), int(target_h * 0.055)
        pad = sh
        layer = Image.new('RGBA', (sw + pad * 2, sh + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse((pad, pad, pad + sw, pad + sh), fill=(0, 0, 0, 110))
        layer = layer.filter(ImageFilter.GaussianBlur(sh * 0.6))
        bg.alpha_composite(
            layer,
            (int(x + (im.width - sw) / 2) - pad, base_y + target_h - sh // 2 - pad))
        if darken > 0:
            # 逆光の場面では、手前の人物が明るいままだと切り貼りに見える。
            # 少しだけ沈めて場に馴染ませる。
            sh_layer = Image.new('RGBA', im.size, (0, 0, 20, int(255 * darken)))
            im = im.copy()
            im.alpha_composite(Image.composite(
                sh_layer, Image.new('RGBA', im.size, (0, 0, 0, 0)),
                im.getchannel('A')))
        bg.alpha_composite(im, (int(x), base_y))
        x += im.width + gap

    bg.convert('RGB').save(out)
    print(f'✓ {out}  ({len(scaled)}人)')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'parts'
    if what == 'parts':
        cmd_parts()
    elif what == 'build':
        cmd_build()
    elif what == 'backs':
        cmd_parts(pose=POSE_BACK, tag='_後')
    elif what == 'climax':
        # 合体。光を見上げる後ろ姿を、ほぼ影にして下端に並べる。
        cmd_build(tag='_後', bg_prompt=BG_CLIMAX, bg_name='_背景合体', bg_seed=7070,
                  height=0.34, darken=0.92, base=1.02,
                  out=os.path.join(cuts.STILL_DIR, '11_合体_1.png'))
    elif what == 'victory':
        # 勝利。逆光の後ろ姿。合体より大きく、少しだけ明るく残す。
        cmd_build(tag='_後', bg_prompt=BG_VICTORY, bg_name='_背景勝利', bg_seed=8080,
                  height=0.46, darken=0.72, base=1.0,
                  out=os.path.join(cuts.STILL_DIR, '12_勝利_1.png'))
    elif what == 'open':
        # 開幕。逆光のシルエットにするので darken を強く効かせる。
        # ここも1人ずつ描いて重ねる ― FLUX に任せると5人になった。
        cmd_build(bg_prompt=BG_OPEN, bg_name='_背景開幕', bg_seed=6060,
                  height=0.30, darken=0.88,
                  out=os.path.join(cuts.STILL_DIR, '01_開幕_1.png'))
    elif what == 'coop':
        # 共闘は最大3人(ゲームの決まり)。火力・盾役・回復役の3人で役割分担を見せる。
        # 後ろ姿にして、巨人へ撃ち込んでいる形にする。
        cmd_build(names=['紅蓮', '紫紺', '翠緑'], tag='_後', bg_prompt=BG_COOP,
                  bg_name='_背景共闘', bg_seed=5150, height=0.42, darken=0.42,
                  base=1.04,
                  out=os.path.join(cuts.STILL_DIR, '05b_共闘_1.png'))
    else:
        raise SystemExit('parts / build のどちらかを指定する')
