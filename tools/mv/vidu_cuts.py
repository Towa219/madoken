# -*- coding: utf-8 -*-
r"""まどけんPV(第2版)の台本。Vidu Q3 で撮る。

第1版(cuts.py / FLUX静止画 + Wan 2.2・44.8秒)との違い:

  ・1カット2秒に固定してカット数を増やす。同じ尺でも切り替わりの密度が倍になる。
  ・人物の顔を正面から見せる。Wan では顔が崩れるので第1版の共闘カットは
    全員後ろ姿だった。Vidu は参照画像でキャラを固定できるので正面が撮れる。
  ・多人数は「絵をこちらで確定させてから動かす」。人数と配置は合成で決め、
    Vidu には img2video で渡して動かすだけにさせる。

★ 撮影は2秒、編集で1.6〜1.8秒に詰める。
  生成動画は頭とケツが不安定になりやすい。どこを落とすかはカットによって
  逆になるので、'keep' で指定する:
    tail … 魔法が出るのは後半。頭の「構えているだけ」を落とす(多数派)
    head … 終わりで光が画面を覆って壊れる。後半を落とす
    mid  … 頭も尻も不安定。真ん中だけ使う

★ クレジット(2026-08-11の実測)
  残高 1,866cr で始めた。通常価格で 24cr/本、オフピーク 12cr(納品SLA48時間)。
  15カット×1テイク = 360cr なので、通常価格でも十分収まる。
  → まず全カット1テイクずつ撮り、悪いものだけ撮り直す方が効率が良い。
    最初から3テイク回すと、1回で通ったカットのぶんが無駄になる。
  同時実行は5本まで。--submit は5本ずつに区切ること。

★ モデルはエンドポイントで違う(vidu_gen.py の MODEL_BY_ENDPOINT)
  reference2video は viduq3、img2video は viduq3-turbo。
  img2video に viduq3 を渡すと 400「model is not supported」で弾かれる。
"""

# ---------------------------------------------------------------- 画風
#
# ★ 全カットで一字一句同じものを使う。ここを変えると絵柄が揃わない。
#   第1版で通った書き方をそのまま踏襲している(ゲームの絵柄と地続きに見える)。
STYLE = (
    'Cel-shaded 3D animated film, cute chibi characters with big heads and short '
    'bodies, about three heads tall, anime faces with large expressive eyes, '
    'hand-painted textures on 3D models, subsurface scattering skin, '
    'volumetric lighting, vivid saturated color grading, '
    'dramatic cinematic lighting, full frame composition without black bars.'
)

# ★ 「ちび」は必ず書くこと(2026-08-11に決定)。
#   参照画像は3頭身で出ているので、動画の文章だけ通常等身の描写になっていると
#   Vidu が両方の間で揺れ、カットごとに背丈が変わる。
#   ちびで迫力を出すのは、体つきではなく次の3つで作る:
#     ・カメラを低く置いて見上げる
#     ・魔法を体に対して大きく描く(炎の壁・氷柱・岩柱)
#     ・巨大なゴーレムと並べて大きさの差を見せる

# 舞台。カットごとに書き直すと場所が繋がって見えないので、これも共通にする。
#
# ★ 「暗い」を必ず入れること(2026-08-11の実測)。
#   最初は明るさを書いていなかったら、広間が昼間のように明るく出て、
#   黒金の雷の白が背景に溶けて飛んだ。魔法の光を見せたいカットばかりなので、
#   地の明るさは低いほうが良い。
STAGE = (
    'Inside a vast dark ruined stone hall with broken pillars and a cracked floor, '
    'deep shadows, only dim cold light from far above, dust in the air.'
)

# ★ 禁じ手
#   ・runes / symbols / ancient writing など文字を連想させる語は使わない。
#     第1版で体に読めない偽の文字(「漉造効」など)が光って出た。
#     文字を出したい時は「割れ目から光が漏れる」と言い換える。
#   ・カメラ指示は1カットに1つだけ。3段に振ったら顔が一度も写らなかった(実測)。
#   ・人数を数字で書いても守られない。多人数は合成で作る。

# ---------------------------------------------------------------- 6人
#
# 第1版で通った記述をそのまま使う。得意エレメントは shared/characters.ts と一致。
CHARS = {
    '黒金': 'a witch girl in a black long coat with gold filigree trim, '
            'oversized pointed black witch hat with a gold band, long flowing black hair, '
            'amber eyes, holding a large open spellbook glowing with golden light',
    '白銀': 'a boy scholar mage in a white and silver robe with a blue sash, '
            'round glasses, neat short silver hair, blue eyes, floating parchment scrolls',
    '紅蓮': 'a battle mage girl in a long crimson red robe coat, dark leather shoulder armor, '
            'a red cape, long bright red hair in a high ponytail, green eyes, '
            'holding a golden staff tipped with flame',
    # ★ フラスコの色を必ず書くこと。色を書かなかったら4枚の参照で
    #   黄・白水色・黄・橙とばらばらに出た(2026-08-11)。
    #   動画にすると1カットの中でも色が変わる。
    '翠緑': 'a herbalist girl in a green hooded cloak, a leather satchel of potion bottles, '
            'braided brown hair, warm brown eyes, '
            'holding a round flask filled with glowing bright green liquid',
    '紫紺': 'a short round old archmage grandpa in a deep purple robe with silver '
            'embroidery, long fluffy white beard, wide brimmed pointed purple hat, '
            'holding a tall gnarled staff topped with a glowing blue orb',
    '蒼氷': 'an ice mage girl in a pale blue and white long coat with a fur trimmed collar, '
            'long silver blue hair, a snowflake hair ornament, pale blue eyes, '
            'holding a glowing pale blue ice crystal',
}

# 参照画像。1人4枚(顔正面・全身正面・斜45°・真横)。
# 夢宮ゆりでこの4枚構成で同一性が保てた。顔だけだと衣装が、全身だけだと顔が崩れる。
REFS = {name: [f'{name}_face.png', f'{name}_front.png',
               f'{name}_45.png', f'{name}_side.png']
        for name in CHARS}

# ---------------------------------------------------------------- 台本
#
# mode  … 'ref' = reference2video(参照でキャラ固定・構図はViduが決める)
#          'img' = img2video(こちらで作った1枚を動かす。人数と配置を守らせたい時)
# sec   … 撮影の長さ。編集で trim まで詰める
# trim  … 完成尺(秒)。頭とケツを落とす
# move  … movement_amplitude。人物が主役なら small、魔法や瓦礫が主役なら large
# still … img モードで渡す1枚の作り方
CUTS = [
    # ============ 前半: 掴み + 6人の必殺(14秒) ============
    {
        # ★ move を medium にしたら、輪がぼやけて溶けた(2026-08-11)。
        #   1枚目は鮮明なのに、動かす過程で崩される。図形が主役のカットは
        #   動きを最小にして「光り方だけが変わる」に留めること。
        'id': '01_開幕', 'mode': 'img', 'sec': 2, 'trim': 1.8, 'keep': 'tail', 'energy': 0.20, 'move': 'small',
        'still': 'lineup.py circle6 — 暗い床に6色の魔法陣を円周状に配置した1枚',
        'prompt': f'{STYLE} {STAGE} '
                  'Six magic circles of different colors — yellow, blue, red, green, '
                  'brown and pale cyan — brighten one after another on the dark stone '
                  'floor. Each circle keeps its exact shape and stays perfectly sharp '
                  'and in place; only its brightness changes. '
                  'Dust motes lift off the floor in the rising glow. '
                  'The camera holds still, looking straight down at the floor.',
        # ★ 人物を入れない。1カット目に6人を出すと必ず数が狂う。
        #   「これから6人が来る」ことは色だけで伝わる。
    },
    {
        'id': '02_黒金_雷', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.70, 'move': 'medium',
        'refs': REFS['黒金'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["黒金"]}. '
                  'She thrusts her open spellbook overhead with one arm. '
                  'A violet magic circle snaps into existence above her and spins, '
                  'and many branching bolts of yellow lightning strike down through it '
                  'onto the floor around her, throwing hard white flashes across the hall. '
                  'Her long black hair and coat blow upward in the discharge. '
                  'She faces the camera. Low angle hero shot, she stays centered '
                  'and fully visible. The camera pushes in slowly.',
    },
    {
        'id': '03_紅蓮_炎', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.75, 'move': 'medium',
        'refs': REFS['紅蓮'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["紅蓮"]}. '
                  'She steps forward and sweeps the flaming staff across in front of her, '
                  'and a wall of fire races outward along the stone floor toward the camera, '
                  'embers and sparks flying up in its wake. '
                  'Her red cape and high ponytail whip in the heat. '
                  'She faces the camera. Low angle action shot, she stays centered '
                  'and fully visible. The camera holds steady.',
    },
    {
        'id': '04_蒼氷_氷', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.70, 'move': 'large',
        'refs': REFS['蒼氷'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["蒼氷"]}. '
                  'She thrusts one open hand forward and enormous jagged spikes of blue ice '
                  'erupt from the floor one after another in a line rushing away from her, '
                  'shattered frost spraying into the air, freezing mist rolling low. '
                  'Her long silver blue hair lifts in the cold blast. '
                  'She faces the camera. She stays on the left of frame and fully visible. '
                  'The camera holds steady.',
    },
    {
        'id': '05_紫紺_土', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.75, 'move': 'large',
        'refs': REFS['紫紺'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["紫紺"]}. '
                  'Huge jagged brown rock pillars burst up out of the stone floor '
                  'one after another right in front of him and tower over him, '
                  'rubble and dust exploding into the air around them. '
                  'He has just slammed the butt of his gnarled staff down onto the floor. '
                  'His long white beard and purple robe billow in the shockwave. '
                  'He faces the camera and stays on the left of frame. '
                  'Low angle shot. The camera holds steady.',
        # ★ 「杖を叩きつけると岩柱が出る」と原因から書いたら、杖を持って
        #   立っているだけになり、岩柱が一本も出なかった(2026-08-11)。
        #   見せたいものを先に、動作を後に書く。
    },
    {
        'id': '06_白銀_水', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.65, 'move': 'medium',
        'refs': REFS['白銀'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["白銀"]}. '
                  'He raises both hands and a huge dome of clear swirling water builds up '
                  'over him, blue light refracting through it, loose droplets orbiting '
                  'in the air. An explosion bursts against the outside of the dome '
                  'and breaks apart harmlessly. His parchment scrolls circle around him. '
                  'He faces the camera. Low angle shot, he stays centered '
                  'and fully visible. The camera holds steady.',
    },
    {
        'id': '07_翠緑_風', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.55, 'move': 'medium',
        # ★ 参照は先頭が強く効く。正面の絵を先頭に置いたままだと、
        #   いくら「斜めに」と書いても正面で出た(2026-08-11)。
        #   斜め45°と真横を先頭に並べ替える。
        'refs': ['翠緑_45.png', '翠緑_side.png', '翠緑_face.png', '翠緑_front.png'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["翠緑"]}. '
                  'Her body is turned side-on to the camera, her shoulders lined up '
                  'front to back so we see her from her left side, and she looks back '
                  'over her shoulder toward the camera. Both of her eyes stay clearly '
                  'visible and nothing covers her face. '
                  'She raises the glowing flask out to the side and above her shoulder, '
                  'well clear of her face, and a tall spiral of green wind twists upward '
                  'around her, carrying glowing leaves and motes of light spinning up '
                  'into the dark. Warm green light washes over the ruins. '
                  'Her green cloak and braids flutter in the updraft. '
                  'She stays centered and fully visible. The camera holds steady.',
        # ★ 正面向きで「フラスコを頭上に掲げる」と書いたら、腕と瓶が顔の前に
        #   来て目が隠れた(2026-08-11)。体を斜めにし、腕を横へ振らせると
        #   顔が空く。掲げる高さではなく「顔から離す」ことを書くのが要点。
    },

    # ============ 後半: 戦闘(16秒) ============
    {
        # ★ 参照なし(text2video)で撮ったら、平坦なベクター調の別絵柄になった。
        #   14_勝利 とも姿が違うゴーレムが出た(2026-08-11)。
        #   画風は文章だけでは固まらない。1枚目をこちらで作って渡す。
        'id': '08_ボス', 'mode': 'img', 'sec': 2, 'trim': 1.8, 'keep': 'tail', 'energy': 0.85, 'move': 'medium',
        'still': 'lineup.py golem_rise — 巨石のゴーレムが立ち上がる1枚',
        'prompt': f'{STYLE} {STAGE} '
                  'The colossal stone guardian golem pushes itself up onto its feet. '
                  'The cyan light in the cracks of its body brightens and pulses. '
                  'Dust and broken stone rain down off its shoulders as it rises, '
                  'and it lowers its head toward the camera. '
                  'The camera holds steady, looking up at it.',
        # ★ 足元に小さな人影を描かせないこと。第1版で5人とも6人ともつかず、
        #   光が育つと溶けて何が起きているか分からなくなった。
    },
    {
        'id': '09_二人_炎氷', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'tail', 'energy': 0.80, 'move': 'large',
        'refs': REFS['紅蓮'][:2] + REFS['蒼氷'][:2],   # 2人ぶん各2枚
        'prompt': f'{STYLE} {STAGE} '
                  f'On the left, {CHARS["紅蓮"]}. '
                  f'On the right, {CHARS["蒼氷"]}. '
                  'They stand shoulder to shoulder and fire at the same moment: '
                  'a torrent of orange fire from the left and a lance of blue ice '
                  'from the right, the two streams twisting around each other '
                  'into a single spiral that tears away from the camera, '
                  'steam exploding off where they meet. '
                  'Both of them stay in frame and face away into the blast. '
                  'The camera holds steady behind them.',
        # ★ 2人なら参照で足りる。3人を超えると人数が崩れるので合成に切り替える。
    },
    {
        'id': '10_苦戦', 'mode': 'ref', 'sec': 2, 'trim': 1.7, 'keep': 'mid', 'energy': 0.35, 'move': 'medium',
        'refs': REFS['紅蓮'],
        'prompt': f'{STYLE} {STAGE} '
                  f'{CHARS["紅蓮"]}. '
                  'A violent blast of wind and debris slams into her from the front. '
                  'She throws one arm across her face to shield her eyes, leans into it, '
                  'drops onto one knee and drives her staff into the cracked floor '
                  'to keep from being blown back. Her cape and ponytail whip backward, '
                  'stones and dust streak past her. The huge dark silhouette of the '
                  'stone giant looms far behind her, strong backlight. '
                  'She fills most of the frame. The camera holds steady.',
        # ★ 苦戦は表情ではなく姿勢で見せる。第1版で「歯を食いしばる」等の
        #   表情指定はほとんど効かず、平然と立っているだけに見えた。
    },
    {
        # ★ 最初は合成1枚から動かす予定だったが、合成では3人が棒立ちになり
        #   「撃っている」ように見えなかった(2026-08-11)。人物と背景を別々に
        #   作る以上、動作と背景は噛み合わない。3人なら参照でも人数は守れる
        #   見込みなので、Vidu に動作ごと作らせる方へ切り替えた。
        'id': '11_三人共闘', 'mode': 'ref', 'sec': 2, 'trim': 1.8, 'keep': 'tail', 'energy': 0.70, 'move': 'medium',
        'refs': REFS['白銀'][:2] + REFS['紅蓮'][:2] + REFS['翠緑'][:2],
        'prompt': f'{STYLE} {STAGE} '
                  f'On the left, {CHARS["白銀"]}. '
                  f'In the middle, {CHARS["紅蓮"]}. '
                  f'On the right, {CHARS["翠緑"]}. '
                  'The three of them hold a line together, side by side. '
                  'The boy on the left throws both hands up and a wide translucent blue '
                  'water barrier flares in front of them. The red haired girl in the '
                  'middle swings her staff and a torrent of fire pours out past the '
                  'barrier. The hooded girl on the right lifts her flask and a spiral '
                  'of green wind winds upward around all three of them. '
                  'Debris flies past on both sides. All three stay in frame. '
                  'The camera pushes in slowly.',
    },
    {
        # ★ move: large では光が画面を覆い尽くし、終わりでキャラが消えた。
        #   文章で光の範囲を縛っても足りず、動きの強さ自体を下げて止めた。
        'id': '12_六人総攻撃', 'mode': 'img', 'sec': 2, 'trim': 1.8, 'keep': 'head', 'energy': 0.90, 'move': 'small',
        'still': 'lineup.py line6 — 6人を横一線に並べ、それぞれの色の光を持たせた1枚',
        'prompt': f'{STYLE} {STAGE} '
                  'Six mages standing in one line all fire their magic at the same '
                  'instant at one single distant target far away down the hall. '
                  'Six thin threads of light — yellow, blue, red, green, brown and '
                  'pale cyan — shoot away from their hands into the depth of the frame '
                  'and converge to one small bright point in the far distance. '
                  'The threads stay thin like wires and get smaller as they go away. '
                  'The six mages stay large, sharp and fully visible in the foreground '
                  'the whole time, their coats and hair blowing back in the recoil. '
                  'The camera holds steady.',
        # ★ 「六色の光が放たれる」と書くと、Vidu はそれを画面手前へ広がる帯として
        #   描き、2度とも画面を埋め尽くしてキャラが消えた(move を large→small に
        #   下げても変わらなかった)。光を「奥へ細く収束する」向きに縛るのが要点。
        # ★ 「the whole hall lit up by them」と書いていたら、後半で光が
        #   画面の6割を覆う極彩色の帯になり、キャラが潰れて背景も消えた
        #   (2026-08-11の実測)。光の範囲を先に縛っておくこと。
        # ★ ここは絶対に参照で撮らない。人数が守れないため合成の1枚から動かす。
    },
    {
        # ★ 「massive pillar of white light」と書いたら、6色の陣が全部その白に
        #   飲まれて単色の光柱になった(2026-08-11)。見せたいのは6色が重なる所
        #   なので、白い柱は書かない。色が残ることを先に言う。
        'id': '13_合体魔法', 'mode': 'img', 'sec': 2, 'trim': 1.8, 'keep': 'mid', 'energy': 1.00, 'move': 'medium',
        'still': 'lineup.py fusion — 6色の魔法陣を重ね、下端に6人の逆光シルエットを置いた1枚',
        'prompt': f'{STYLE} {STAGE} '
                  'Six rings of light — yellow, blue, red, green, brown and pale cyan — '
                  'spin at different speeds and slide together into one another. '
                  'Every ring keeps its own distinct color the whole time and none of '
                  'them turns white. Energy ripples outward from where they overlap. '
                  'All six mages stand in a row along the bottom of the frame, '
                  'lit from the front so that every one of the six stays clearly '
                  'visible and separate from the dark background the whole time. '
                  'They stay still. The camera holds steady.',
        # ★ 逆光のシルエットにしたら、6人のうち4人が背景に溶けて
        #   「3人しかいない」と見えた(2026-08-11)。
        #   雰囲気より「6人いると分かる」ことを優先し、前から光を当てる。
    },
    {
        # ★ 08 と同じ golem_rise.png から動かす。
        #   崩壊の絵を別に描かせたら(golem_fall)、ブロック玩具のような
        #   まったく別のゴーレムが出た(2026-08-11)。
        #   img2video は1枚目からそのまま動き出すので、同じ絵を渡せば
        #   姿は必ず一致する。崩れる動きはプロンプトだけで作らせる。
        #   ※ lineup.py の golem_fall は使っていない(比較用に残してある)。
        # ★ 崩壊は「参照」で撮る(2026-08-11)。
        #   ゴーレムの絵をキャラクター参照として渡すと、Vidu はその姿を保つ。
        #   ここに至るまでの失敗:
        #   ・08と同じ絵から img2video → 前半が08とそっくりで「また出てきた」
        #   ・崩壊の絵を FLUX で別に描く → 別のゴーレムになり、しかも他人が入る
        #   ・人物なしの余韻カットを FLUX で描く → 6案すべてに人が描き込まれた
        #     (FLUX は cfg 1.0 でネガティブが届かず 'no people' が効かない)
        #   参照なら姿は Vidu が保ち、人物は文章で抑えられる。
        'id': '14_勝利', 'mode': 'ref', 'sec': 2, 'trim': 1.8, 'keep': 'tail', 'energy': 0.55, 'move': 'large',
        'refs': ['ゴーレム.png'],
        'prompt': f'{STYLE} {STAGE} '
                  'The colossal stone guardian is breaking apart and collapsing. '
                  'Its stone body splits into huge chunks that tear loose and tumble '
                  'down to the ground, glowing warm gold along every broken edge, '
                  'while small motes of golden light rise up through the falling '
                  'rubble. The heavy stone falls downward, only the light goes up. '
                  'Warm dawn light floods in from above. '
                  'No people and no other creature are anywhere in the frame. '
                  'The camera holds steady.',
        # ★ 「破片が舞い上がる」と書いた版は、崩れているのではなく
        #   打ち上がっているように見えた。石は下へ、光だけ上へ、と分けること。
    },
    {
        # ★ 逆再生で使う(2026-08-11)。
        #   Vidu は「笑顔で始まって最後に真顔」を作った ― 締めとして逆。
        #   撮り直さず反転すれば、真顔から笑顔へ変わる締めになる。
        #   クレジットも生成の待ち時間も要らない。
        #   この手が使えるのは、動きが小さく向きの無いカットだけ。
        #   炎や瓦礫のように「落ちる」ものが写っていると、逆再生だと分かる。
        'id': '15_集合', 'mode': 'img', 'sec': 2, 'trim': 1.9, 'keep': 'tail',
        'reverse': True, 'energy': 0.45, 'move': 'small',
        'still': 'lineup.py build — 6人を横に並べた集合絵(第1版のものを流用できる)',
        'prompt': f'{STYLE} {STAGE} '
                  'The six mages stand together in a row facing the camera in the warm '
                  'dawn light, their magic still glowing faintly in their hands. '
                  'Dust motes drift through the light, their cloaks and hair sway gently. '
                  'All of them stay in frame and stay still. '
                  'The camera holds steady.',
        # 題字とURLはここに重ねる(titles.py)。動きは最小にする ―
        # 文字の下で人物が動くと目が散る。
    },
]

# 撮影 30秒ぶん / 完成 26.4秒 + 締めの余韻で30秒に整える
TOTAL_SHOT = sum(c['sec'] for c in CUTS)
TOTAL_TRIM = sum(c['trim'] for c in CUTS)


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'カット数 {len(CUTS)} / 撮影 {TOTAL_SHOT}秒 / 完成 {TOTAL_TRIM:.1f}秒')
    ref = sum(1 for c in CUTS if c['mode'] == 'ref')
    img = sum(1 for c in CUTS if c['mode'] == 'img')
    print(f'  参照で撮る {ref}カット / 合成1枚から動かす {img}カット')
    print(f'  3テイクずつ = {len(CUTS) * 3}本 = '
          f'{len(CUTS) * 3 * 12}クレジット(オフピーク) / 持ち玉800')
    for c in CUTS:
        print(f'  {c["id"]:16s} {c["mode"]} {c["sec"]}→{c["trim"]}秒 {c["move"]}')
