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
import vidu_cuts  # 第2版の人物順を唯一の基準にする

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
PART_DIR = os.path.join(HERE, 'parts')
# Vidu へ渡す参照画像。合成カットの素材もここから取る(等身を揃えるため)
REF_DIR = os.path.join(HERE, 'ref_vidu')
VIDU_STILL_DIR = os.path.join(HERE, 'still_vidu')

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


def foot_y(im, min_ratio=0.16):
    """足が地面に着く高さ(画像の上からの画素)を返す。

    ★ 画像の下端＝足元、ではない(2026-08-11)。
      紅蓮の杖や紫紺の杖の石突きは足より下まで伸びるので、
      画像の下端で揃えると、その2人だけ地面に着いて他が浮く。
      実際、集合カットで4人が宙に浮いて見えた。

    細い棒は無視して、体の幅がある行のうち一番下を足元と見なす。
    しきい値は「その絵で最も広い行の16%」。杖は数画素なので落ちる。
    """
    import numpy as np
    alpha = np.array(im.convert('RGBA'))[:, :, 3] > 40
    widths = alpha.sum(axis=1)
    if not widths.any():
        return im.height - 1
    limit = widths.max() * min_ratio
    rows = np.nonzero(widths >= limit)[0]
    return int(rows[-1]) if len(rows) else im.height - 1


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

# Vidu第2版で使う、人物を含めない真上視点の開幕背景。
# ★ 陣は描かせない。床だけ描かせて、輪は cmd_circle6 が重ねる。
#   「魔法陣」と書くと必ず読めない偽の文字が入り、数も配置も守られない。
BG_CIRCLE6 = (
    'Cel-shaded 3D animated film background art, top-down view looking straight '
    'down at a dark cracked stone floor of an old ruined hall, deep cracks and '
    'worn masonry, scattered dust and small gravel, dim cold light, '
    'plain empty floor, sharp focus, no blur, widescreen composition')

# 正面を向いた三人の役割が、一枚で読める共闘背景。
BG_COOP_FRONT = (
    'stylized 3D animated film background art, empty ruined stone hall, a broad '
    'translucent blue water shield on the left, bright orange fire gathering in '
    'the center, a spiral of luminous green wind on the right, cracked stone '
    'floor, vivid saturated colors, sharp focus, no people, epic wide shot')

# 六人の手元の属性光を背景側にも馴染ませる。
BG_LINE6 = (
    'stylized 3D animated film background art, empty vast ruined stone hall, six '
    'soft pools of colored light across the foreground in this order from left '
    'to right: yellow, blue, red, green, brown, pale cyan, cracked stone floor, '
    'vivid saturated colors, sharp focus, no people, epic wide shot')


def cmd_build(picks=None, out=None, names=None, bg_prompt=None, bg_name='_背景',
              bg_seed=4242, height=0.62, darken=0.0, tag='', base=0.95,
              glow_colors=None, ref_view=None):
    from PIL import Image
    picks = picks or (BACK_PICKS if tag == '_後' else {})
    names = names or ORDER
    bg_prompt = bg_prompt or BG_LINEUP
    out = out or os.path.join(cuts.STILL_DIR, '13_集合_1.png')
    # Vidu入力の最低寸法を満たす。旧版の704px高もここで720pxへ拡張する。
    W, H = max(cuts.W, 1280), max(cuts.H, 720)

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
    #
    # ★ Vidu用(ref_view を渡した時)は tools/mv/ref_vidu の参照画像を素材にする。
    #   parts/ は第1版PVのもので等身が高い。いま Vidu に渡す参照はちび体型なので、
    #   合成カットだけ parts/ を使うと、そのカットだけ背の高い別人が並ぶ。
    #   Vidu が見る参照そのものを素材にすれば、必ず一致する。
    figs = []
    for name in names:
        if ref_view:
            src = os.path.join(REF_DIR, f'{name}_{ref_view}.png')
            if not os.path.exists(src):
                raise SystemExit(f'{src} が無い。先に ref_sheet.py を走らせること')
            figs.append((name, trim(Image.open(src).convert('RGBA'))))
            continue
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
    #
    # ★ 揃えるのは「足の高さ」であって画像の下端ではない。
    #   杖の石突きが足より下へ出ている絵があり、下端で揃えると
    #   その人だけ接地して他が浮く(2026-08-11に集合カットで発生)。
    #   1人ずつ「足がどこか」を測って、そのぶん下へずらす。
    target_h = int(H * height)
    scaled = []
    for name, im in figs:
        r = target_h / im.height
        resized = im.resize((max(1, int(im.width * r)), target_h), Image.LANCZOS)
        # 画像の下端から足までの余り(杖などのはみ出し)を測る
        drop = target_h - 1 - foot_y(resized)
        scaled.append((name, resized, drop))
    if any(d for _, _, d in scaled):
        print('   足元の補正: ' + ' / '.join(
            f'{n}{d:+d}px' for n, _, d in scaled if d))

    # 横に等間隔で置く。少し重ねて、集合写真らしく詰める。
    total = sum(im.width for _, im, _ in scaled)
    gap = (W - total) / (len(scaled) + 1)
    x = gap
    base_y = int(H * base) - target_h        # 足元をそろえる
    from PIL import ImageDraw, ImageFilter
    for name, im, drop in scaled:
        # drop のぶん下へずらすと、足が base_y + target_h の線に乗る。
        y = base_y + drop
        # 影を落とす。地面から浮いて見えるのを防ぐ。
        # 四角いままだと板を敷いたように見えるので、楕円にしてぼかす。
        # 影も足の位置に置く(画像の下端ではない)。
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
        bg.alpha_composite(im, (int(x), y))
        x += im.width + gap

    # 属性光は人物の手元付近へ柔らかく重ねる。背景の色と合わせて切り貼り感を抑える。
    if glow_colors:
        from PIL import ImageDraw, ImageFilter
        glow_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow_layer)
        step = W / len(glow_colors)
        radius = max(28, int(H * 0.055))
        for index, color in enumerate(glow_colors):
            cx = int(step * (index + 0.5))
            cy = int(base_y + target_h * 0.48)
            glow_draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), fill=(*color, 220))
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius * 0.7))
        bg = Image.alpha_composite(bg, glow_layer)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    bg.convert('RGB').save(out)
    print(f'✓ {out}  ({len(scaled)}人)')


# ゴーレムの決めカット。08(登場)と14(崩壊)で同じ姿にするため、
# 画風ブロックは vidu_cuts.STYLE をそのまま使う。
#
# ★ 参照なし(text2video)で撮ったら、08も14も平坦なベクター調の別絵柄になり、
#   しかも互いに違うゴーレムが出た(2026-08-11の実測)。
#   画風はプロンプトの文章だけでは固まらない ― 1枚目をこちらで作って渡す。
# ★ 口を描かせないこと(2026-08-11)。
#   顔に口を描く余地を残すと、必ず笑った顔になる。ボスに見えない。
#   目だけの顔にすると、それだけで威圧感が出る。8案とも例外なくそうなった。
GOLEM_RISE = (
    'a colossal ancient stone guardian golem pushing itself up onto its feet '
    'inside a vast dark ruined stone hall, '
    'a blank featureless stone face with no mouth and no nose, only two narrow '
    'glowing cyan slits where the eyes would be, '
    'cyan light bleeding out through the '
    'deep cracks and seams in its weathered stone body, no markings on it, '
    'dust and broken stone falling off its shoulders, its head lowering toward '
    'the viewer, extreme low angle looking up, overwhelming scale, '
    'cold blue light, deep shadows')

# 勝利の余韻の「地」だけ。人が入り込む余地のない画にする。
#
# ★ 人を出さない方法は「人が入る場所を作らない」しかない(2026-08-11)。
#   FLUX は cfg 1.0 でネガティブが届かないので、'no people' は効かない。
#   ・「戦いの後の広間」で6案 → 6案すべてに子どもが描き込まれた
#   ・種を振っても逃げられない。題材そのものが人を呼ぶ
#   広間・遺跡・床といった「人が立てる場所」を描かせず、
#   暗がりと光の柱だけにする。瓦礫と光の粒はこちらで描いて重ねる
#   (01_開幕 の魔法陣と同じ作り方)。
GOLEM_FALL = (
    'Cel-shaded 3D animated film background art, looking straight up into a wide '
    'shaft of warm dawn light coming down through a hole high above in darkness, '
    'thick haze and drifting dust lit from behind, deep black surroundings with no '
    'floor and no walls visible, no architecture, abstract light study, '
    'warm golden backlight, soft glow')


# ★ FLUX は cfg 1.0 なのでネガティブが効かない(cuts.py の注記)。
#   「人を描くな」と書いても届かず、6案中5案に見知らぬ子どもが3人ほど
#   描き込まれた(2026-08-11)。しかもその絵をそのままPVに使ってしまい、
#   まどけんのキャラでない3人が12秒あたりに映っていた。
#   種を振って選ぶしかないので、通った種をここに残す。
#   2755 … 6案中で唯一、人物がまったく描かれていない。これを使う。
#
# ★ 「造形の良い絵の他人を消す」は失敗した(2026-08-11)。
#   暗く沈めるだけでは人の形が残り、床を横から貼り替えると
#   横一線の継ぎ目が出てゴーレムの脚まで切れた。
#   絵の一部を後から作り替えるのは、この作り方では無理。
#   最初から人が居ない絵を引くこと。
GOLEM_SEED = 2755


def cmd_golem(kind):
    """ゴーレムの1枚を作る。08(登場)と14(崩壊)で使う。

    足元に描き込まれた他人を消し、自前の3人(紅蓮・白銀・翠緑)を
    後ろ姿で小さく置く。大きさの対比を残しつつ、正しいキャラにする。
    """
    from PIL import Image, ImageDraw, ImageFilter
    os.makedirs(VIDU_STILL_DIR, exist_ok=True)
    prompt = GOLEM_RISE if kind == 'rise' else GOLEM_FALL
    wf = cuts.still_workflow(f'{vidu_cuts.STYLE} {prompt}', GOLEM_SEED)
    hist, _ = cuts.run(wf, f'golem_{kind}', limit=300)
    images = cuts.collect(hist, 'images')
    if not images:
        raise SystemExit('ゴーレムの画像が生成されませんでした')
    W, H = 1280, 720
    im = unletterbox(Image.open(images[0]).convert('RGB')).resize((W, H), Image.LANCZOS)
    im = im.convert('RGBA')

    # 余韻(fall)は「光の柱だけ」を地にして、瓦礫と光の粒をこちらで描く。
    if kind != 'rise':
        import math
        import random
        rnd = random.Random(4148)          # 毎回同じ絵になるよう種を固定
        draw_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        dd = ImageDraw.Draw(draw_layer)

        # 舞い上がる光の粒。上へ行くほど小さく淡くする。
        for _ in range(420):
            px = rnd.uniform(W * 0.18, W * 0.82)
            py = rnd.uniform(H * 0.05, H * 0.98)
            up = 1.0 - py / H                      # 上ほど1に近い
            r = rnd.uniform(1.2, 3.4) * (1.0 - up * 0.55)
            a = int(rnd.uniform(90, 235) * (1.0 - up * 0.5))
            dd.ellipse((px - r, py - r, px + r, py + r), fill=(255, 216, 140, a))

        # 落ちてくる瓦礫。★上へ飛ばさないこと ―
        #   「破片が舞い上がる」と書いた版は、崩れているのではなく
        #   打ち上がっているように見えた(2026-08-11の指摘)。
        #   石は下へ、光の粒だけが上へ、と役割を分ける。
        for _ in range(16):
            px = rnd.uniform(W * 0.08, W * 0.92)
            py = rnd.uniform(H * 0.10, H * 0.80)
            s = rnd.uniform(9, 26)
            ang = rnd.uniform(0, math.pi)
            pts = []
            for k in range(5):
                t = ang + k * 2 * math.pi / 5
                rr = s * rnd.uniform(0.6, 1.0)
                pts.append((px + rr * math.cos(t), py + rr * math.sin(t) * 0.8))
            dd.polygon(pts, fill=(96, 88, 78, 236))
            # 落下の筋(下向き)を薄く引く
            dd.line([(px, py + s), (px, py + s * 3.2)], fill=(96, 88, 78, 70), width=2)

        im.alpha_composite(draw_layer.filter(ImageFilter.GaussianBlur(0.6)))
        out = os.path.join(VIDU_STILL_DIR, f'golem_{kind}.png')
        im.convert('RGB').save(out)
        print(f'✓ {out}  (人物なし。光の粒は上へ、瓦礫は下へ)')
        return

    # 自前の3人を後ろ姿で置く。ゴーレムの大きさが伝わる程度に小さく。
    trio = ['白銀', '紅蓮', '翠緑']
    target_h = int(H * 0.15)
    figs = []
    for name in trio:
        src = os.path.join(REF_DIR, f'{name}_front.png')
        f = trim(Image.open(src).convert('RGBA'))
        r = target_h / f.height
        f = f.resize((max(1, int(f.width * r)), target_h), Image.LANCZOS)
        figs.append((name, f, target_h - 1 - foot_y(f)))
    ground = int(H * 0.965)
    xs = [int(W * 0.34), int(W * 0.50), int(W * 0.65)]
    for (name, f, drop), cx in zip(figs, xs):
        # 逆光に立つ後ろ姿として、ほぼ影にする。顔が読めないので向きも問われない。
        dark = Image.new('RGBA', f.size, (4, 8, 16, 224))
        f = f.copy()
        f.alpha_composite(Image.composite(
            dark, Image.new('RGBA', f.size, (0, 0, 0, 0)), f.getchannel('A')))
        im.alpha_composite(f, (cx - f.width // 2, ground - target_h + drop))

    out = os.path.join(VIDU_STILL_DIR, f'golem_{kind}.png')
    im.convert('RGB').save(out)
    print(f'✓ {out}  (足元の他人を消し、自前の3人を置いた)')


def cmd_circle6():
    """六色の魔法陣。床だけ FLUX に描かせ、輪はこちらで描く。

    ★ 陣を FLUX に描かせてはいけない(2026-08-11に実測)。
      「円周状に6つ」と書いても2段のグリッドに並び、色は赤3つ・
      青緑黄が1つずつになり、しかも陣の中に読めない偽の文字が入った。
      FLUX は cfg 1.0 で動かすので数も配置も否定も届かない。
      並べる位置と色はこちらが決められる ― lineup と同じ考え方。
    """
    from PIL import Image, ImageDraw, ImageFilter
    import math
    os.makedirs(VIDU_STILL_DIR, exist_ok=True)

    W, H = 1280, 720
    wf = cuts.still_workflow(BG_CIRCLE6, 6106)
    hist, _ = cuts.run(wf, 'circle6_床', limit=300)
    images = cuts.collect(hist, 'images')
    if not images:
        raise SystemExit('床の画像が生成されませんでした')
    bg = unletterbox(Image.open(images[0]).convert('RGB')).resize((W, H), Image.LANCZOS)
    bg = bg.convert('RGBA')

    # 台本の並び順と同じ6色(黒金=雷/白銀=水/紅蓮=火/翠緑=風/紫紺=土/蒼氷=氷)
    colors = [(255, 220, 40), (60, 150, 255), (255, 55, 35),
              (55, 220, 85), (185, 130, 60), (155, 235, 255)]
    cx, cy = W * 0.5, H * 0.52
    rx, ry = W * 0.29, H * 0.30      # 真上から見るので楕円に置く
    ring = int(H * 0.105)

    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    sharp = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sharp)
    for i, col in enumerate(colors):
        a = math.radians(-90 + i * 60)          # 真上から時計回りに6つ
        x, y = cx + rx * math.cos(a), cy + ry * math.sin(a)
        # 光のにじみ(下に敷く)
        gd.ellipse((x - ring, y - ring * 0.72, x + ring, y + ring * 0.72),
                   fill=(*col, 150))
        # 輪。二重にして「魔法陣らしさ」を出す。文字は入れない ―
        # 読めない偽の字が出る原因はいつも文字を描かせることにある。
        for k, wdt in ((1.00, 5), (0.72, 3), (0.44, 2)):
            sd.ellipse((x - ring * k, y - ring * k * 0.72,
                        x + ring * k, y + ring * k * 0.72),
                       outline=(*col, 235), width=wdt)
    glow = glow.filter(ImageFilter.GaussianBlur(ring * 0.55))
    out_im = Image.alpha_composite(Image.alpha_composite(bg, glow), sharp)

    out = os.path.join(VIDU_STILL_DIR, 'circle6.png')
    out_im.convert('RGB').save(out)
    print(f'✓ {out}（床はFLUX・6つの輪はこちらで配置）')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'parts'
    if what == 'parts':
        cmd_parts()
    elif what == 'build':
        cmd_build(names=list(vidu_cuts.CHARS), ref_view='front',
                  out=os.path.join(VIDU_STILL_DIR, 'build.png'))
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
    elif what == 'circle6':
        cmd_circle6()
    elif what == 'coop3':
        # 左から白銀（水の盾）、紅蓮（炎）、翠緑（風）。全員を正面向きで置く。
        cmd_build(names=['白銀', '紅蓮', '翠緑'], bg_prompt=BG_COOP_FRONT,
                  bg_name='_背景Vidu共闘', bg_seed=6113, height=0.62,
                  ref_view='front',
                  out=os.path.join(VIDU_STILL_DIR, 'coop3.png'))
    elif what == 'line6':
        # 台本のCHARS順と同じ順序で並べ、各人の手元へ属性色を重ねる。
        cmd_build(names=list(vidu_cuts.CHARS), bg_prompt=BG_LINE6,
                  bg_name='_背景Vidu六人', bg_seed=6116, height=0.58,
                  ref_view='front',
                  glow_colors=[(255, 220, 40), (60, 150, 255), (255, 55, 35),
                               (55, 220, 85), (150, 95, 45), (155, 235, 255)],
                  out=os.path.join(VIDU_STILL_DIR, 'line6.png'))
    elif what == 'fusion':
        # 六色魔法陣の下端へ、逆光でほぼ黒い六人の後ろ姿を置く。
        # 逆光で真っ黒に落とすので、向きは読めない。前向きの参照で足りる。
        cmd_build(names=list(vidu_cuts.CHARS), bg_prompt=BG_CLIMAX,
                  # ★ 0.34 では小さすぎて、動かすと誰が居るのか読めなくなった。
                  # ★ darken 0.90 でも沈みすぎ。動画にすると6人のうち4人が
                  #   背景に溶け、「3人しかいない」と見えた(2026-08-11)。
                  #   逆光の雰囲気より「6人いると分かる」ことを優先する。
                  bg_name='_背景Vidu合体', bg_seed=6119, height=0.46,
                  ref_view='front',
                  darken=0.45, base=1.02,
                  out=os.path.join(VIDU_STILL_DIR, 'fusion.png'))
    elif what == 'golem_rise':
        cmd_golem('rise')
    elif what == 'golem_fall':
        cmd_golem('fall')
    else:
        raise SystemExit('parts / build / backs / circle6 / coop3 / line6 / '
                         'fusion / golem_rise / golem_fall のどれかを指定してください')
