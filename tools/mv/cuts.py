# 紹介動画の台本。カットの中身はすべてここに書く。
#
# 2段構えで作る。
#   ① FLUX で「決めカット」を静止画にする  → python tools/mv/cuts.py still
#   ② その1枚を Wan 2.2 で動かす           → python tools/mv/cuts.py video
#   ③ ffmpeg で繋ぐ                        → python tools/mv/cuts.py join
#
# 文章だけから動画を作らせるとキャラの姿が毎回変わる。
# ①で姿を固めてから②に渡すので、同じキャラのまま動く。
#
# 実行は ComfyUI 同梱の python で:
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/cuts.py still

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

COMFY = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
COMFY_ROOT = os.environ.get('COMFY_ROOT', r'D:\ComfyUI\ComfyUI')
INPUT_DIR = os.path.join(COMFY_ROOT, 'input')
OUTPUT_DIR = os.path.join(COMFY_ROOT, 'output')
HERE = os.path.dirname(os.path.abspath(__file__))
STILL_DIR = os.path.join(HERE, 'still')
CLIP_DIR = os.path.join(HERE, 'clip')

W, H = 1280, 704   # Wan は縦横とも32で割り切れる必要がある
SHIFT_DEFAULT = 6.0  # 動きの強さ(上げると崩れ、下げると止まって見える)
FPS = 24

# ---- 絵柄(全カット共通) ----
#
# 「アニメ寄りの3D」に寄せる指定。作品名は書かない ―
# 実際に "Arcane Netflix" と書いたら、絵の隅に偽のロゴ文字が描き込まれた。
STYLE = (
    'stylized 3D animated film still, cel shaded 3D characters with anime faces, '
    'large expressive eyes, hand painted textures on 3D models, '
    'painterly stylized 3D render, subsurface scattering skin, volumetric lighting, '
    'vivid saturated color grading, dramatic cinematic lighting, '
    'full frame composition without black bars'
)

# ★ FLUX schnell は cfg 1.0 で動かすので、この「除外」はほぼ効かない。
#   避けたいものは、肯定側で誘わないことでしか防げない。実際に起きたこと:
#     ・作品名を書いたら、絵の隅に偽のロゴ文字が描き込まれた
#     ・「壁」「神殿」を強く書くと、壁に読めない偽の漢字が並んだ
#     ・6人を並べて書くと、設定を無視した別人の集団になった
#   群像は「逆光のシルエット」「後ろ姿」に逃がし、
#   顔を見せるカットは必ず1人だけにすること。
NEG_STILL = 'photorealistic, live action, text, watermark, logo, signature, ugly, deformed'
# こちらは cfg 5.0 で動かすので、FLUX と違って除外がきちんと効く。
# 「振り向く」を入れてあるのは、後ろ姿のカットで顔が回り込んで崩れたため。
NEG_VIDEO = (
    'blurry, low quality, jpeg artifacts, watermark, text, subtitles, logo, '
    'extra limbs, extra fingers, deformed hands, distorted face, morphing face, '
    'flickering, jittery motion, static image, still frame, duplicate character, '
    'turning around, looking back over the shoulder, looking at the camera, '
    'face rotating, head spinning'
)

# ---- キャラクターの設定(ゲーム本体の subjects_flux.json と揃える) ----
#
# 得意エレメントは shared/characters.ts のとおり。
# 白銀=水 / 翠緑=風 は v0.91.0 で入れ替えたので、間違えないこと。
CHARS = {
    '黒金': 'a witch girl in a black long coat with gold filigree trim, '
            'oversized pointed black witch hat with a gold band, long flowing black hair, '
            'amber eyes, holding a large open spellbook glowing with golden light',
    '白銀': 'a boy scholar mage in a white and silver robe with a blue sash, '
            'round glasses, neat short silver hair, blue eyes, floating parchment scrolls',
    '紅蓮': 'a battle mage girl in a long crimson red robe coat, dark leather shoulder armor, '
            'a red cape, long bright red hair in a high ponytail, green eyes, '
            'holding a golden staff tipped with flame',
    '翠緑': 'a herbalist girl in a green hooded cloak, a leather satchel of potion bottles, '
            'braided brown hair, warm brown eyes, holding a round glowing flask',
    '紫紺': 'a short round old archmage grandpa in a deep purple robe with silver rune '
            'embroidery, long fluffy white beard, wide brimmed pointed purple hat, '
            'holding a tall gnarled staff topped with a glowing blue orb',
    '蒼氷': 'an ice mage girl in a pale blue and white long coat with a fur trimmed collar, '
            'long silver blue hair, a snowflake hair ornament, pale blue eyes, '
            'holding a glowing ice crystal',
}

# ---- 台本 ----
#
# still  … FLUX に描かせる決めカット
# move   … その絵を Wan にどう動かさせるか(カメラと、動くものだけを書く)
# sec    … 長さ
# pick   … 何案か描かせたうちの何番を使うか(選んだ結果をここに残す)
# shift  … 動きの強さ。省くと SHIFT_DEFAULT。
#
# ★ shift を上げすぎると3秒で行き過ぎる。最初 8.0 で全カット作ったら、
#   黒金は顔が消えて帽子だけになり、白銀はカメラが足元まで下がって
#   頭が切れ、合体は真っ白に飛んだ。人物が主役のカットは 5.0 前後にして、
#   「画面の中央に留まる」と書き添えること。
CUTS = [
    {
        'id': '01_開幕',
        'pick': 1,
        'sec': 3.5,
        # FLUX に任せたら5人になったので、ここも1人ずつ描いて重ねている
        # (tools/mv/lineup.py open)。逆光のシルエットで顔は見せない。
        'shift': 5.0,
        'still': '(tools/mv/lineup.py open で組み立てる。ここでは描かせない)',
        'move': 'light from the open doorway slowly brightens, dust drifts through '
                'the light, the six figures cloaks sway gently, '
                'very slow camera push forward, all six stay in frame',
    },
    {
        'id': '02_黒金',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["黒金"]}, raising her glowing spellbook overhead, '
                 'crackling yellow lightning arcs across the frame, '
                 'a violet magic circle spinning above her, dark ruined hall, low angle hero shot',
        'shift': 5.0,
        'move': 'lightning flickers and crackles around her, her long hair and coat sway '
                'gently, the magic circle above rotates slowly, sparks drift, '
                'very slow camera push in, she stays centered and fully visible in frame',
    },
    {
        'id': '03_紅蓮',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["紅蓮"]}, charging forward and swinging the flaming staff, '
                 'a wave of fire sweeping across the stone floor, embers everywhere, '
                 'orange magic circle beneath her feet, dynamic low angle action shot',
        'shift': 5.0,
        'move': 'the flame on her staff flickers and licks upward, her red cape and ponytail '
                'flutter in the heat, embers drift upward, the magic circle turns slowly, '
                'very slow camera push in, she stays centered and fully visible in frame',
    },
    {
        'id': '04_蒼氷',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["蒼氷"]}, thrusting her hand forward as enormous jagged ice spikes '
                 'erupt from the floor, pale blue light, frost crystals floating in the air, '
                 'freezing mist rolling low, cold blue lighting, dynamic shot',
        'move': 'giant ice spikes erupt one after another from the floor, '
                'frost crystals drift, mist rolls forward, her long hair sways, camera pulls back',
    },
    {
        'id': '05_ボス',
        'pick': 2,
        'sec': 3.5,
        # ★ 最初は足元に小さな人影を6人描かせていたが、5人とも6人ともつかず、
        #   光が育つと溶け合って何が起きているか分からなくなった。
        #   小さすぎる人物は Wan でも保てない。ここは巨人だけにして、
        #   人物は次の共闘カットで見せる。
        # ★ 「runes(古代文字)」と書くと、体に読める偽の文字が光って出る
        #   (「RV」「BO」「漉造効」など)。文字を連想させる語は使わず、
        #   「割れ目から光が漏れる」と言い換えること。
        'still': 'a colossal ancient stone guardian golem awakening, standing up, '
                 'glowing cyan light bleeding out through deep cracks and seams in its '
                 'weathered stone body, no markings and no symbols on it, '
                 'its head lowering toward the viewer, falling dust and stone debris, '
                 'empty cracked ground below, deserted, no people, '
                 'extreme low angle, overwhelming scale, ominous, cold blue lighting',
        'shift': 5.0,
        'move': 'the cyan light in its cracks brightens and pulses, '
                'its head lowers slowly toward the viewer, dust and small debris fall, '
                'the camera tilts up slowly along its body, '
                'the lighting stays cold and dark and does not blow out',
    },
    {
        # 共闘は最大3人(ゲームの決まり)。火力・盾役・回復役で役割分担を見せる。
        # この1枚は FLUX に群像を描かせず、1人ずつ描いて重ねて作っている
        # (tools/mv/lineup.py coop)。FLUX は人数を合わせられないため。
        'id': '05b_共闘',
        'pick': 1,
        'sec': 3.5,
        # 人物は背を向けたまま動かさない。動きは魔法と瓦礫に持たせる。
        # shift 5.0 では紅蓮が振り向いて顔が崩れたので 3.5 まで落とした。
        'shift': 3.5,
        'still': '(tools/mv/lineup.py coop で組み立てる。ここでは描かせない)',
        'move': 'the burst of impact light on the golem chest flares and crackles, '
                'the green wind spiral swirls, debris and dust fly past, '
                'the three mages stand firm with their backs to the camera, '
                'only their capes and hair sway, nobody turns around, '
                'their faces stay hidden, very slow camera push in',
    },
    {
        'id': '06_予告',
        'pick': 2,
        'sec': 3.0,
        'still': 'an enormous glowing red rune circle spreading across a cracked stone floor, '
                 'seen from high above, the massive stone arms of a giant guardian raised '
                 'overhead at the top of frame, red warning light pulsing outward, '
                 'floating dust and gravel, no people, ominous red lighting',
        'move': 'the red rune circle pulses and expands across the floor, '
                'the golem raises its arms higher, energy gathers, camera slowly rises',
    },
    {
        'id': '07_苦戦',
        'pick': 3,
        'sec': 3.0,
        # ★ 最初は「吹き飛ばされる」構図にしていたが、瓦礫と motion blur に
        #   埋もれて本人が見えなくなった。飛んでいる人物は Wan でも画面外へ
        #   流れやすい。片膝をついて耐える形にすると人物が大きく残り、動きも
        #   壊れない。苦戦は「飛ばされる」より「立ち上がれない」方が伝わる。
        # ★ 2度書き直している。
        #   1度目「吹き飛ばされる」→ 瓦礫と motion blur に埋もれて本人が消えた。
        #   2度目「片膝をついて耐える」→ 平然とした顔で立っているだけに見えた。
        #     cfg 1.0 では「歯を食いしばる」「息が上がる」といった表情の指定が
        #     ほとんど効かない。苦戦は表情ではなく動作で見せるしかない。
        #   3度目(これ)「腕で顔をかばい、風圧に耐えて踏ん張る」。
        #     何が起きているかが姿勢だけで分かる。
        'still': f'{CHARS["紅蓮"]}, bracing against a violent blast of wind and debris '
                 'coming from the front, one arm raised across her face to shield her eyes, '
                 'leaning forward into the wind, one knee bent low, her staff planted hard '
                 'into the cracked ground to hold her position, cape and long ponytail '
                 'whipping violently backward, small stones and dust streaking past her, '
                 'the huge dark silhouette of the stone giant far behind, strong backlight, '
                 'she fills most of the frame, a single girl alone, one character only',
        'shift': 4.0,
        'move': 'her shoulders rise and fall as she breathes hard, the weak flame on her '
                'staff flickers, embers and dust drift slowly past, her torn cape sways, '
                'she slowly lifts her head, camera holds steady and pushes in very slowly, '
                'she stays centered and fully visible in frame',
    },
    {
        'id': '08_白銀',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["白銀"]} standing alone in the foreground, both hands raised, '
                 'a huge translucent dome of swirling water forming above him, '
                 'blue light refracting through the water, droplets suspended in the air, '
                 'an explosion breaking apart against the outside of the dome, '
                 'two dim backlit silhouettes crouching far behind him, heroic low angle',
        'shift': 5.0,
        'move': 'the dome of water above him ripples and swirls, droplets orbit slowly, '
                'the explosion outside scatters against it, his scrolls flutter, '
                'camera holds steady, he stays centered and fully visible in frame',
    },
    {
        'id': '09_翠緑',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["翠緑"]} standing alone in the foreground, holding her glowing flask '
                 'high above her head, a tall spiral of green wind carrying glowing leaves '
                 'and motes of light swirling upward around her, warm green healing glow '
                 'lighting the dark ruins, two dim silhouettes rising to their feet '
                 'in the background haze, gentle hopeful mood',
        'move': 'a spiral of green wind and glowing leaves swirls upward around the allies, '
                'they slowly stand up, her cloak and braids flutter, soft light pulses',
    },
    {
        'id': '10_紫紺',
        'pick': 1,
        'sec': 3.0,
        'still': f'{CHARS["紫紺"]}, slamming his staff down, the stone floor cracking and '
                 'enormous rock pillars erupting upward toward the colossal golem, '
                 'dust and debris, brown and gold earth magic light, powerful low angle',
        'shift': 5.0,
        'move': 'cracks spread slowly across the floor, dust and small stones drift upward, '
                'his beard and robe sway, the orb on his staff pulses, '
                'camera holds steady, he stays fully visible in frame',
    },
    {
        'id': '11_合体',
        'pick': 1,
        'sec': 4.0,
        'still': 'six glowing magic circles of different colors, yellow blue red green brown '
                 'and pale cyan, stacked one above another and merging into a single enormous '
                 'circle, a massive pillar of white light erupting upward through them, '
                 'blinding energy and shockwave rings, six small dark backlit silhouettes '
                 'of robed mages seen from behind at the bottom of frame, epic wide shot',
        'shift': 5.0,
        'move': 'the six colored magic circles rotate slowly at different speeds, '
                'the pillar of light pulses and shimmers, energy rings ripple outward, '
                'the silhouettes at the bottom stay still, very slow camera pull back, '
                'the light stays contained and does not wash out the frame',
    },
    {
        'id': '12_勝利',
        'pick': 1,
        'sec': 4.0,
        'still': 'six mage heroes standing together seen from behind, looking up at the '
                 'crumbling colossal golem collapsing into glowing fragments, '
                 'motes of light rising into a shaft of dawn light, dust settling, '
                 'triumphant calm, epic wide shot, warm golden light',
        'move': 'the golem crumbles into glowing fragments that rise slowly into the light, '
                'dust settles, the heroes cloaks flutter gently, slow camera push in',
    },
    {
        # 6人が並ぶ締め。これも1人ずつ描いて重ねている
        # (tools/mv/lineup.py build)。FLUX に「6人」と書いても
        # 5人や8人になり、しかも全員が別人になるため。
        'id': '13_集合',
        'pick': 1,
        'sec': 4.0,
        'shift': 4.0,
        'still': '(tools/mv/lineup.py build で組み立てる。ここでは描かせない)',
        'move': 'the six mages stand still and look at the viewer, their cloaks and hair '
                'sway gently, dust motes drift through the shafts of golden light, '
                'the flame and the orbs they hold flicker, very slow camera push in, '
                'all six stay fully visible in frame',
    },
]


# ===== ComfyUI とのやりとり =====

def post(path, payload):
    req = urllib.request.Request(
        f'{COMFY}{path}', data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def get(path):
    with urllib.request.urlopen(f'{COMFY}{path}', timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def run(workflow, label, limit=3600):
    pid = post('/prompt', {'prompt': workflow})['prompt_id']
    started = time.time()
    last = -1
    while True:
        time.sleep(2)
        hist = get(f'/history/{pid}')
        if pid in hist:
            h = hist[pid]
            st = h.get('status', {})
            if st.get('status_str') == 'error':
                for m in st.get('messages', []):
                    if m[0] == 'execution_error':
                        raise RuntimeError(m[1].get('exception_message', '不明'))
                raise RuntimeError('失敗')
            return h, time.time() - started
        sec = int(time.time() - started)
        if sec // 20 != last:
            last = sec // 20
            if sec:
                print(f'     {label} …{sec}秒')
        if time.time() - started > limit:
            raise RuntimeError('時間切れ')


def collect(hist, key):
    out = []
    for node in hist.get('outputs', {}).values():
        for v in node.get(key, []):
            p = os.path.join(OUTPUT_DIR, v.get('subfolder', ''), v['filename'])
            if os.path.exists(p):
                out.append(p)
    return out


# ===== ① 決めカット(FLUX) =====

def still_workflow(prompt, seed):
    return {
        '1': {'class_type': 'CheckpointLoaderSimple',
              'inputs': {'ckpt_name': 'flux1-schnell-fp8.safetensors'}},
        '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['1', 1]}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_STILL, 'clip': ['1', 1]}},
        '4': {'class_type': 'EmptySD3LatentImage',
              'inputs': {'width': W, 'height': H, 'batch_size': 1}},
        '5': {'class_type': 'KSampler',
              'inputs': {'model': ['1', 0], 'positive': ['2', 0], 'negative': ['3', 0],
                         'latent_image': ['4', 0], 'seed': seed, 'steps': 4, 'cfg': 1.0,
                         'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1.0}},
        '6': {'class_type': 'VAEDecode', 'inputs': {'samples': ['5', 0], 'vae': ['1', 2]}},
        '7': {'class_type': 'SaveImage',
              'inputs': {'images': ['6', 0], 'filename_prefix': 'mv_still'}},
    }


def cmd_still(only=None, variants=2):
    os.makedirs(STILL_DIR, exist_ok=True)
    for cut in CUTS:
        if only and cut['id'] not in only:
            continue
        if cut['still'].startswith('('):
            print(f"  飛ばす({cut['id']}): lineup.py で組み立てるカット")
            continue
        print(f"▶ {cut['id']} の決めカット")
        for v in range(variants):
            seed = (abs(hash(cut['id'])) + v * 9973) % (2 ** 31)
            hist, took = run(still_workflow(f"{STYLE}, {cut['still']}", seed),
                             cut['id'], limit=300)
            for p in collect(hist, 'images'):
                dst = os.path.join(STILL_DIR, f"{cut['id']}_{v + 1}.png")
                shutil.copyfile(p, dst)
                print(f'   {took:.0f}秒  {dst}')


# ===== ② 動かす(Wan 2.2) =====

def video_workflow(image_name, prompt, length, seed, out_prefix, steps=20, shift=6.0):
    return {
        '1': {'class_type': 'UNETLoader',
              'inputs': {'unet_name': 'wan2.2_ti2v_5B_fp16.safetensors',
                         'weight_dtype': 'default'}},
        '2': {'class_type': 'CLIPLoader',
              'inputs': {'clip_name': 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
                         'type': 'wan', 'device': 'default'}},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'wan2.2_vae.safetensors'}},
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_VIDEO, 'clip': ['2', 0]}},
        '7': {'class_type': 'Wan22ImageToVideoLatent',
              'inputs': {'vae': ['3', 0], 'width': W, 'height': H,
                         'length': length, 'batch_size': 1, 'start_image': ['4', 0]}},
        '8': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['1', 0], 'shift': shift}},
        '9': {'class_type': 'KSampler',
              'inputs': {'model': ['8', 0], 'positive': ['5', 0], 'negative': ['6', 0],
                         'latent_image': ['7', 0], 'seed': seed, 'steps': steps, 'cfg': 5.0,
                         'sampler_name': 'uni_pc', 'scheduler': 'simple', 'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['3', 0]}},
        '11': {'class_type': 'CreateVideo', 'inputs': {'images': ['10', 0], 'fps': float(FPS)}},
        '12': {'class_type': 'SaveVideo',
               'inputs': {'video': ['11', 0], 'filename_prefix': out_prefix,
                          'format': 'mp4', 'codec': 'h264'}},
    }


def cmd_video(only=None, steps=20):
    os.makedirs(CLIP_DIR, exist_ok=True)
    os.makedirs(INPUT_DIR, exist_ok=True)
    for cut in CUTS:
        if only and cut['id'] not in only:
            continue
        src = os.path.join(STILL_DIR, f"{cut['id']}_{cut.get('pick', 1)}.png")
        if not os.path.exists(src):
            print(f"  飛ばす({cut['id']}): 決めカットが無い")
            continue
        name = f"mv_{cut['id']}.png"
        shutil.copyfile(src, os.path.join(INPUT_DIR, name))
        # Wan は時間方向を4つまとめて圧縮するので、コマ数は 4n+1 に合わせる
        length = max(5, ((int(round(cut['sec'] * FPS)) - 1) // 4) * 4 + 1)
        seed = abs(hash(cut['id'] + 'v')) % (2 ** 31)
        print(f"▶ {cut['id']} を動かす({length}コマ / {length / FPS:.1f}秒)")
        hist, took = run(video_workflow(name, cut['move'], length, seed,
                                        f"mv/{cut['id']}", steps,
                                        cut.get('shift', SHIFT_DEFAULT)), cut['id'])
        for p in collect(hist, 'videos') or collect(hist, 'images'):
            dst = os.path.join(CLIP_DIR, f"{cut['id']}.mp4")
            shutil.copyfile(p, dst)
            print(f'   {took:.0f}秒  {dst}')


# ===== ③ 繋ぐ =====

def ffprobe():
    """ffmpeg と同じ場所にある ffprobe。

    パスの中の 'ffmpeg' を置換してはいけない ―
    入っているフォルダ名にも 'ffmpeg-8.1.2-full_build' と含まれていて、
    そちらまで書き換わって見つからなくなる(実際にやった)。
    """
    ff = ffmpeg()
    head, tail = os.path.split(ff)
    return os.path.join(head, tail.replace('ffmpeg', 'ffprobe', 1))


def ffmpeg():
    p = shutil.which('ffmpeg')
    if p:
        return p
    guess = (r'C:\Users\ai_to\AppData\Local\Microsoft\WinGet\Packages'
             r'\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
             r'\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe')
    if os.path.exists(guess):
        return guess
    raise SystemExit('ffmpeg が見つからない')


# 採用した曲。3分33秒あるので、使う区間の頭も一緒に覚えておく。
#
# ★ 頭から使ってはいけない。曲の出だしは前置きで、動画の山(合体の光の柱)と
#   噛み合わない。曲全体の音量を2.5秒ごとに測り、「動画の山のところで
#   曲も山になる」窓を総当たりで探して決めている。
#   カットを足し引きすると山の位置がずれるので、そのたびに測り直すこと:
#       python tools/mv/cuts.py fit
BGM = os.path.join(HERE, 'bgm', 'Sign-of-Victory.mp3')
BGM_START = 40.0


def clip_len(cut):
    """そのカットの実尺(秒)。Wan は 4n+1 コマでしか作れないので丸める。"""
    return max(5, ((int(round(cut['sec'] * FPS)) - 1) // 4) * 4 + 1) / FPS


def timeline():
    """各カットの開始・終了(秒)。"""
    t = 0.0
    out = []
    for c in CUTS:
        d = clip_len(c)
        out.append((c['id'], t, t + d))
        t += d
    return out, t


def cmd_fit(climax_id='11_合体', step=2.5):
    """曲のどこを切り出すと、動画の山と曲の山が重なるかを測って決める。"""
    import re
    marks, total = timeline()
    hit = [m for m in marks if m[0] == climax_id]
    if not hit:
        raise SystemExit(f'{climax_id} が台本に無い')
    _, cs, ce = hit[0]
    print(f'動画の全長 {total:.1f}秒 / 山({climax_id}) {cs:.1f}〜{ce:.1f}秒')

    ff = ffmpeg()
    dur = float(subprocess.run(
        [ffprobe(), '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', BGM],
        capture_output=True, text=True).stdout.strip())

    prof = []
    t = 0.0
    while t < dur:
        out = subprocess.run(
            [ff, '-hide_banner', '-nostats', '-ss', f'{t:.1f}', '-t', str(step),
             '-i', BGM, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'],
            capture_output=True, text=True, errors='replace').stderr
        m = re.findall(r'RMS level dB:\s*(-?[\d.]+|-inf)', out)
        prof.append(float(m[-1]) if m and m[-1] != '-inf' else -99.0)
        t += step

    n = int(total / step)
    pf, pt = int(cs / step), min(n - 1, int(ce / step))
    best = None
    for i in range(0, len(prof) - n):
        w = prof[i:i + n]
        if min(w) < -45:          # 途中で無音になる窓は使わない
            continue
        climax = sum(w[pf:pt + 1]) / (pt - pf + 1)
        head = sum(w[:4]) / 4
        rest = sum(w) / len(w)
        score = (climax - rest) * 2 + (climax - head)
        if best is None or score > best[0]:
            best = (score, i, head, climax, rest)
    if not best:
        raise SystemExit('使える区間が見つからない')
    _, i, head, climax, rest = best
    print(f'▶ 使う区間: {i * step:.1f}秒 〜 {i * step + total:.1f}秒')
    print(f'   出だし {head:.1f}dB / 山 {climax:.1f}dB / 平均 {rest:.1f}dB')
    print(f'   山は出だしより {climax - head:+.1f}dB、平均より {climax - rest:+.1f}dB 大きい')
    print(f'   → cuts.py の BGM_START を {i * step:.1f} にすること')


# 重ねる文字(tools/mv/titles.py で作る)
OVERLAY_DIR = os.path.join(HERE, 'overlay')
TITLE_IN, TITLE_HOLD, TITLE_OUT = 0.7, 3.9, 0.9   # 出る / 見せる / 消える(秒)
END_LEN = 4.6                                      # 終わりのURLを出す長さ(秒)


def cmd_join(out=None, bgm=None, bgm_start=None):
    out = out or os.path.join(HERE, 'madoken_pv.mp4')
    bgm = bgm or BGM
    bgm_start = BGM_START if bgm_start is None else bgm_start
    clips = [os.path.join(CLIP_DIR, f"{c['id']}.mp4") for c in CUTS]
    clips = [c for c in clips if os.path.exists(c)]
    if not clips:
        raise SystemExit('繋ぐ動画が無い')
    lst = os.path.join(CLIP_DIR, '_list.txt')
    with open(lst, 'w', encoding='utf-8') as f:
        for c in clips:
            f.write("file '" + os.path.abspath(c) + "'\n")

    ff = ffmpeg()
    total = timeline()[1]
    # 題名は1コマずつ描いた連番PNG(tools/mv/titles.py)。
    # 1枚絵を overlay で動かすと、座標が整数しか取れずカクついた。
    title_seq = os.path.join(OVERLAY_DIR, 'title_seq', '%04d.png')
    end = os.path.join(OVERLAY_DIR, 'end.png')
    has_text = (os.path.isdir(os.path.dirname(title_seq))
                and os.path.exists(end))
    has_bgm = bool(bgm and os.path.exists(bgm))

    cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error',
           '-f', 'concat', '-safe', '0', '-i', lst]
    if has_bgm:
        # 曲は途中から切り出す。頭は0.6秒で入り、終わりは1.8秒かけて引く ―
        # 曲の途中でぶつ切りにすると、切れた瞬間が耳に付く。
        cmd += ['-ss', f'{bgm_start:.2f}', '-t', f'{total:.2f}', '-i', bgm]
    if has_text:
        # 静止画を流し続ける入力にする。時計は本編と同じ0秒から進むので、
        # 出す時刻をそのまま指定できる。
        cmd += ['-framerate', str(FPS), '-i', title_seq,
                '-loop', '1', '-i', end]

    chains = []
    vout = '0:v'
    if has_text:
        ti = 2 if has_bgm else 1
        ei = ti + 1
        e_in = max(0.0, total - END_LEN)
        # 出方・消え方・大きさの変化は連番の側に焼き込んである。
        # ここでは重ねるだけ(ずらさない)。
        chains.append(f'[{ti}:v]format=rgba[t]')
        chains.append(f'[{ei}:v]format=rgba,fade=in:st={e_in:.2f}:d=1.0:alpha=1[e]')
        chains.append('[0:v][t]overlay=x=0:y=0:eof_action=pass[v1]')
        chains.append('[v1][e]overlay=x=0:y=0[v]')
        vout = 'v'
    if has_bgm:
        chains.append(
            f'[1:a]afade=t=in:st=0:d=0.6,'
            f'afade=t=out:st={total - 1.8:.2f}:d=1.8[a]')

    if chains:
        cmd += ['-filter_complex', ';'.join(chains)]
    cmd += ['-map', f'[{vout}]' if vout == 'v' else vout]
    if has_bgm:
        cmd += ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k']
    cmd += ['-shortest', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', out]
    subprocess.run(cmd, check=True)
    print(f'✓ {out}  ({len(clips)}カット / {total:.1f}秒 / '
          f'{os.path.getsize(out) / 1024 / 1024:.1f}MB'
          + (' / 文字あり' if has_text else '') + ')')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'still'
    rest = [a for a in sys.argv[2:] if not a.startswith('--')]
    if what == 'still':
        cmd_still(only=rest or None)
    elif what == 'video':
        cmd_video(only=rest or None)
    elif what == 'join':
        cmd_join(bgm=rest[0] if rest else None)
    elif what == 'fit':
        cmd_fit()
    else:
        raise SystemExit('still / video / join / fit のどれかを指定する')
