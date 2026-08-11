# 魔導研究記 効果音ジェネレータ(自前合成)
#
# 波形を直接組み立てて効果音を作る。外部の学習モデルを使わないので、
# ライセンスの制約も表示義務も無く、完全に自前の素材になる。
#
#   python gen_sfx.py --all        … 27種すべてを public/sound/sfx/ に作る
#   python gen_sfx.py --only hit
#   python gen_sfx.py --manifest   … manifest.json に登録する
#
# 音量の方針:
#   鳴る回数が桁違いに多いもの(hit / cast / select / click)は小さめに、
#   滅多に鳴らないもの(discover / win / lose)は大きめにしてある。

import argparse
import os
import struct
import sys
import wave

TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
SOUND_DIR = os.path.join(PROJECT, 'public', 'sound')
SFX_DIR = os.path.join(SOUND_DIR, 'sfx')

SR = 44100


# ===== 基本の道具 =====

def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def sine(freq, dur, phase=0.0):
    """freq は数値でも配列(時間変化)でもよい。"""
    t = t_axis(dur)
    f = np.asarray(freq, dtype=float)
    if f.ndim == 0:
        return np.sin(2 * np.pi * f * t + phase)
    # 周波数が動く場合は位相を積分して作る(ブツ切れを防ぐ)
    return np.sin(2 * np.pi * np.cumsum(f) / SR + phase)


def sweep(f0, f1, dur, curve=1.0):
    """f0 から f1 へ変化する周波数列。curve>1 で最初が速い。"""
    x = np.linspace(0, 1, int(SR * dur)) ** curve
    return f0 + (f1 - f0) * x


def noise(dur, seed=0):
    rng = np.random.default_rng(seed)
    return rng.uniform(-1, 1, int(SR * dur))


def lowpass(x, cutoff):
    """一次のローパス(素直で軽い)。"""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):          # 短い音なので素直に回して問題ない
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def env_decay(dur, power=3.0):
    """立ち上がりが速く、あとは減衰していく包絡。"""
    return (1 - np.linspace(0, 1, int(SR * dur))) ** power


def env_ad(dur, attack=0.01, power=3.0):
    """短い立ち上がり + 減衰。"""
    n = int(SR * dur)
    na = max(1, int(SR * attack))
    e = np.empty(n)
    e[:na] = np.linspace(0, 1, na)
    e[na:] = (1 - np.linspace(0, 1, n - na)) ** power
    return e


def fftconv(a, b):
    """畳み込み。残響を作るのに使う(素直に回すと遅すぎるのでFFTで)。"""
    n = 1
    while n < len(a) + len(b) - 1:
        n *= 2
    y = np.fft.irfft(np.fft.rfft(a, n) * np.fft.rfft(b, n), n)
    return y[:len(a) + len(b) - 1]


def reverb(x, tail=0.9, amount=0.35, seed=5):
    """石造りの広間のような余韻を付ける。

    余韻が無いと、どんなに音を選んでも「電子音を並べただけ」に聞こえる。
    """
    n = int(SR * tail)
    rng = np.random.default_rng(seed)
    ir = rng.uniform(-1, 1, n) * np.exp(-np.linspace(0, 6.5, n))
    ir = lowpass(ir, 4500)
    ir[0] += 1.0
    y = fftconv(x, ir)
    y = y / max(1e-9, np.max(np.abs(y)))
    out = np.zeros(len(y))
    out[:len(x)] += x * (1 - amount)
    out += y * amount
    # 余韻が消えたあとの無音を切り落とす(そのままだと1秒近くぶら下がる)
    m = np.max(np.abs(out))
    if m > 1e-9:
        loud = np.where(np.abs(out) > m * 0.0015)[0]
        if len(loud):
            out = out[:min(len(out), loud[-1] + int(SR * 0.05))]
    return out


def tone(f, dur, partials, detune=0.0):
    """倍音を重ねた音色。サイン波1本より格段に厚くなる。

    detune を入れるとわずかにずれた音が重なり、複数人で吹いたような揺らぎが出る。
    """
    x = np.zeros(int(SR * dur))
    for i, a in enumerate(partials, start=1):
        if a <= 0:
            continue
        x += sine(f * i, dur) * a
        if detune:
            x += sine(f * i * (1 + detune), dur) * a * 0.6
    return x / max(1e-9, np.max(np.abs(x)))


def bell(f, dur, ratios=(1.0, 2.76, 5.40, 8.93), gains=(1.0, 0.5, 0.28, 0.15)):
    """鐘の音。倍音が整数倍でないので、金属的で澄んだ響きになる。"""
    x = np.zeros(int(SR * dur))
    for r, g in zip(ratios, gains):
        x += sine(f * r, dur) * env_decay(dur, 1.6 + r * 0.35) * g
    return x / max(1e-9, np.max(np.abs(x)))


def at(x, start, total):
    """音を指定の位置に置く。"""
    out = np.zeros(int(SR * total))
    o = int(SR * start)
    n = min(len(x), len(out) - o)
    if n > 0:
        out[o:o + n] += x[:n]
    return out


def fit(a, b):
    """長さの違う配列を短い方に合わせる。"""
    n = min(len(a), len(b))
    return a[:n], b[:n]


def mix(*parts):
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[:len(p)] += p
    return out


def norm(x, peak=0.7):
    m = np.max(np.abs(x))
    return x * (peak / m) if m > 1e-9 else x


def seamless(make, dur, cross=0.12):
    """繰り返しても継ぎ目が分からないループを作る。

    末尾を先頭に重ねて溶かすことで、最後から最初へ戻る瞬間の段差を消す。
    """
    x = make(dur + cross)
    n = int(SR * dur)
    c = int(SR * cross)
    out = x[:n].copy()
    fade = np.linspace(0, 1, c)
    out[:c] = out[:c] * fade + x[n:n + c] * (1 - fade)
    return out


def save(name, x, peak=0.7):
    os.makedirs(SFX_DIR, exist_ok=True)
    y = norm(x, peak)
    # 端のプチッという音を防ぐため、ごく短くフェードする
    e = int(SR * 0.004)
    if len(y) > 2 * e:
        y[:e] *= np.linspace(0, 1, e)
        y[-e:] *= np.linspace(1, 0, e)
    data = np.clip(y, -1, 1)
    pcm = (data * 32767).astype('<i2')
    path = os.path.join(SFX_DIR, f'{name}.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f'  {name}.wav  {len(pcm) / SR:.2f}秒  {os.path.getsize(path) / 1024:.0f} KB')


# ===== 各効果音 =====
# 返り値は (波形, ピーク音量)

def sfx_select():
    d = 0.09
    x = sine(sweep(760, 1000, d), d) * env_ad(d, 0.004, 4)
    return x, 0.30


def sfx_unselect():
    d = 0.09
    x = sine(sweep(620, 400, d), d) * env_ad(d, 0.004, 4)
    return x, 0.28


def sfx_click():
    d = 0.05
    x = mix(sine(1500, d) * env_ad(d, 0.002, 6) * 0.5,
            highpass(noise(d, 1), 3000) * env_decay(d, 8) * 0.3)
    return x, 0.20


def sfx_crafting():
    # ぐつぐつと煮える持続音。低い唸りに、泡がぽこぽこ弾ける
    def make(d):
        n = int(SR * d)
        t = np.arange(n) / SR
        hum = np.sin(2 * np.pi * 70 * t) * 0.5 + np.sin(2 * np.pi * 105 * t) * 0.25
        hum *= 0.8 + 0.2 * np.sin(2 * np.pi * 1.5 * t)
        bub = np.zeros(n)
        rng = np.random.default_rng(7)
        for k in range(int(d * 9)):
            at = int(rng.uniform(0, n - SR * 0.1))
            ln = int(SR * 0.07)
            f = sweep(rng.uniform(180, 320), rng.uniform(500, 800), 0.07)
            bub[at:at + ln] += (sine(f, 0.07) * env_ad(0.07, 0.005, 5))[:ln] * 0.5
        return lowpass(mix(hum, bub), 2200)
    return seamless(make, 1.6), 0.42


def sfx_craft():
    # 完成のきらめき(和音を短く重ねる)
    d = 0.9
    parts = []
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5]):
        s = i * 0.055
        seg = sine(f, d - s) * env_decay(d - s, 3.5)
        seg = np.concatenate([np.zeros(int(SR * s)), seg])
        parts.append(seg * (0.9 - i * 0.12))
    return mix(*parts), 0.55


def sfx_craft_fail():
    d = 0.6
    x = mix(sine(sweep(400, 150, d, 0.7), d) * env_decay(d, 2) * 0.8,
            sine(sweep(404, 152, d, 0.7), d) * env_decay(d, 2) * 0.5)  # わずかにずらして濁らせる
    return lowpass(x, 2500), 0.45


def sfx_gathering():
    # 草をかき分けるような、さらさらした持続音
    def make(d):
        n = int(SR * d)
        t = np.arange(n) / SR
        base = highpass(noise(d, 3), 1200) * 0.5
        base *= 0.55 + 0.45 * np.sin(2 * np.pi * 2.3 * t)
        return lowpass(base, 6000)
    # 採取中はずっと鳴り続けるので、控えめにしてある(0.30は大きすぎた)
    return seamless(make, 1.6), 0.15


def sfx_gather():
    d = 0.5
    parts = []
    for i, f in enumerate([1046.5, 1318.5, 1568.0]):
        s = i * 0.06
        seg = sine(f, 0.22) * env_ad(0.22, 0.004, 5)
        parts.append(np.concatenate([np.zeros(int(SR * s)), seg]))
    x = mix(*parts)
    return np.concatenate([x, np.zeros(max(0, int(SR * d) - len(x)))]), 0.45


def sfx_transmuting():
    # 材質が変わっていくような、揺らぐ持続音
    def make(d):
        n = int(SR * d)
        t = np.arange(n) / SR
        a = np.sin(2 * np.pi * 330 * t)
        b = np.sin(2 * np.pi * 333.5 * t)      # わずかにずらしてうねりを出す
        c = np.sin(2 * np.pi * 495 * t) * 0.4
        x = (a + b + c) * (0.6 + 0.4 * np.sin(2 * np.pi * 3.1 * t))
        return lowpass(x, 3500)
    return seamless(make, 1.6), 0.34


def sfx_transmute():
    d = 0.7
    x = mix(sine(sweep(300, 900, 0.35), 0.35) * env_ad(0.35, 0.01, 2) * 0.7,
            np.concatenate([np.zeros(int(SR * 0.28)),
                            sine(1174.7, 0.42) * env_decay(0.42, 3)]) * 0.8)
    return np.concatenate([x, np.zeros(max(0, int(SR * d) - len(x)))]), 0.5


def sfx_discover():
    # 滅多に鳴らないので、最も豪華に
    d = 1.4
    parts = []
    for i, f in enumerate([523.25, 659.25, 783.99, 987.77, 1318.5]):
        s = i * 0.075
        ln = d - s
        seg = mix(sine(f, ln) * env_decay(ln, 2.2),
                  sine(f * 2, ln) * env_decay(ln, 3.5) * 0.35)
        parts.append(np.concatenate([np.zeros(int(SR * s)), seg]) * (1 - i * 0.1))
    shimmer = highpass(noise(d, 11), 5000) * env_decay(d, 1.5) * 0.15
    return mix(*parts, shimmer), 0.7


def sfx_casting():
    # 力を溜める持続音。目立ちすぎないよう低めに
    def make(d):
        n = int(SR * d)
        t = np.arange(n) / SR
        low = np.sin(2 * np.pi * 110 * t) * 0.6 + np.sin(2 * np.pi * 165 * t) * 0.3
        shim = highpass(noise(d, 5), 2500) * 0.18
        shim *= 0.5 + 0.5 * np.sin(2 * np.pi * 4.7 * t)
        return lowpass(mix(low, shim), 4000)
    return seamless(make, 1.6), 0.26


def sfx_cast():
    d = 0.3
    air = highpass(noise(d, 13), 900) * env_ad(d, 0.01, 3) * 0.5
    body = sine(sweep(520, 900, d, 0.6), d) * env_ad(d, 0.008, 4) * 0.6
    return mix(air, body), 0.32


def sfx_enemy_cast():
    d = 0.34
    air = lowpass(noise(d, 17), 1800) * env_ad(d, 0.015, 3) * 0.6
    body = sine(sweep(300, 170, d, 0.8), d) * env_ad(d, 0.01, 3) * 0.7
    return mix(air, body), 0.34


def sfx_hit():
    d = 0.16
    thump = sine(sweep(220, 70, d, 0.5), d) * env_decay(d, 4) * 0.9
    crack = highpass(noise(d, 19), 1800) * env_decay(d, 9) * 0.5
    return mix(thump, crack), 0.30


def sfx_crit():
    d = 0.4
    thump = sine(sweep(300, 80, 0.2, 0.5), 0.2) * env_decay(0.2, 4)
    crack = highpass(noise(0.2, 23), 2500) * env_decay(0.2, 7) * 0.7
    ring = mix(sine(1760, d) * env_decay(d, 2.5) * 0.35,
               sine(2637, d) * env_decay(d, 3.5) * 0.2)
    return mix(thump, crack, ring), 0.5


def sfx_damage():
    d = 0.3
    thud = sine(sweep(150, 55, d, 0.6), d) * env_decay(d, 3) * 1.0
    body = lowpass(noise(d, 29), 700) * env_decay(d, 5) * 0.6
    return mix(thud, body), 0.42


def sfx_defeat():
    d = 0.6
    fall = sine(sweep(420, 90, d, 1.4), d) * env_decay(d, 2) * 0.8
    dust = lowpass(highpass(noise(d, 31), 600), 4000) * env_decay(d, 2.5) * 0.5
    return mix(fall, dust), 0.5


def sfx_heal():
    d = 0.8
    parts = []
    for i, f in enumerate([523.25, 783.99, 1046.5]):
        s = i * 0.09
        ln = d - s
        parts.append(np.concatenate([np.zeros(int(SR * s)),
                                     sine(f, ln) * env_ad(ln, 0.05, 2.2)]) * (0.9 - i * 0.15))
    x = mix(*parts)
    t = np.arange(len(x)) / SR
    return x * (0.85 + 0.15 * np.sin(2 * np.pi * 5.5 * t)), 0.45


def sfx_shield():
    d = 0.55
    ring = mix(sine(392, d) * env_ad(d, 0.012, 2.5),
               sine(587.3, d) * env_ad(d, 0.012, 3) * 0.6,
               sine(784, d) * env_ad(d, 0.012, 4) * 0.3)
    clang = highpass(noise(0.06, 37), 2000) * env_decay(0.06, 5) * 0.4
    return mix(ring, clang), 0.45


def sfx_buff():
    d = 0.55
    parts = []
    for i, f in enumerate([440, 554.4, 659.3, 880]):
        s = i * 0.05
        ln = d - s
        parts.append(np.concatenate([np.zeros(int(SR * s)),
                                     sine(f, ln) * env_decay(ln, 3)]) * (0.85 - i * 0.1))
    return mix(*parts), 0.45


def sfx_quake():
    d = 1.1
    t = np.arange(int(SR * d)) / SR
    rumble = lowpass(noise(d, 41), 120) * 1.0
    rumble *= 0.6 + 0.4 * np.sin(2 * np.pi * 7 * t)
    sub = np.sin(2 * np.pi * 42 * t) * 0.5
    x = mix(rumble, sub) * env_ad(d, 0.05, 1.6)
    return x, 0.6


def sfx_countdown():
    d = 0.16
    return sine(700, d) * env_ad(d, 0.005, 4), 0.4


def sfx_start():
    d = 0.8
    x = mix(sine(880, d) * env_decay(d, 2.2),
            sine(1318.5, d) * env_decay(d, 2.8) * 0.6,
            sine(1760, d) * env_decay(d, 3.5) * 0.3)
    # 開戦のたびに鳴るうえ高い音なので耳に付きやすい(0.6は大きすぎた)
    return x, 0.42


def sfx_win():
    # 短いファンファーレ(ド→ミ→ソ→高いド)
    notes = [(523.25, 0.0, 0.30), (659.25, 0.16, 0.30),
             (783.99, 0.32, 0.30), (1046.5, 0.48, 0.85)]
    total = 1.4
    parts = []
    for f, s, ln in notes:
        seg = mix(sine(f, ln) * env_ad(ln, 0.01, 2.4),
                  sine(f * 2, ln) * env_ad(ln, 0.01, 3.2) * 0.3)
        parts.append(np.concatenate([np.zeros(int(SR * s)), seg]))
    x = mix(*parts)
    return np.concatenate([x, np.zeros(max(0, int(SR * total) - len(x)))]), 0.65


def sfx_lose():
    # 沈んでいく(ラ→ファ→レ)
    notes = [(440, 0.0, 0.5), (349.2, 0.3, 0.5), (293.7, 0.6, 0.8)]
    total = 1.5
    parts = []
    for f, s, ln in notes:
        seg = mix(sine(f, ln) * env_ad(ln, 0.02, 2),
                  sine(f * 0.5, ln) * env_ad(ln, 0.02, 2) * 0.5)
        parts.append(np.concatenate([np.zeros(int(SR * s)), seg]))
    x = lowpass(mix(*parts), 2000)
    return np.concatenate([x, np.zeros(max(0, int(SR * total) - len(x)))]), 0.5


def sfx_escape():
    d = 0.65
    air = highpass(noise(d, 43), 700) * env_ad(d, 0.02, 2) * 0.6
    body = sine(sweep(700, 180, d, 1.2), d) * env_ad(d, 0.02, 2) * 0.7
    return lowpass(mix(air, body), 5000), 0.42


# ===== 勝利音 =====
#
# 旧版(sfx_win)はサイン波の単音をド→ミ→ソ→ドと並べただけで、
# 倍音も和音も余韻も無いため着信音のように聞こえた。
# 差し替え後は「音色を厚くする・和音で終わる・余韻を残す」の3点を守ること。

BRASS = (1.0, 0.62, 0.46, 0.32, 0.22, 0.14, 0.08)


def sfx_win_c():
    """勝鬨: 上昇する気配 → 太鼓の一撃 → 開いた五度の厚い和音。

    長三度を抜いてあるので甘くならず勇ましく響く。
    """
    total = 2.2
    parts = []

    # 立ち上がりの上昇ノイズ(これがあると「来るぞ」という間ができる)
    rise = 0.35
    sw = highpass(noise(rise, 13), 900) * (np.linspace(0, 1, int(SR * rise)) ** 2) * 0.4
    parts.append(at(sw, 0.0, total))

    # 太鼓の一撃
    dr = 0.5
    drum = mix(sine(sweep(140, 45, dr, 2.0), dr) * env_decay(dr, 3.0) * 1.0,
               lowpass(noise(dr, 3), 800) * env_decay(dr, 6.0) * 0.4)
    parts.append(at(drum, 0.33, total))

    # 開いた五度(ド・ソ)を重ねた厚い和音。長三度を抜くと勇ましく響く。
    ch = 1.3
    t = np.arange(int(SR * ch)) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t)      # わずかに揺らして生っぽく
    for f, g in [(130.81, 0.45), (196.0, 0.4), (261.63, 0.7),
                 (392.0, 0.6), (523.25, 0.45)]:
        v = tone(f, ch, BRASS, 0.006) * env_ad(ch, 0.03, 1.2) * g * vib
        parts.append(at(v, 0.35, total))

    x = lowpass(mix(*parts), 8000)
    return reverb(x, 1.2, 0.36, 23), 0.65


# ===== ガチャ =====
# 3段階の演出に1つずつ。溜め → 開封 → (レアなら)確定音。

def sfx_gacha_charge():
    """魔法陣が回り出して力が溜まっていく音。だんだん大きく高くなる。

    他の音と違って減衰させない。終わりに向かって上がりきった所で
    開封音に切り替わるので、途中で減ると勢いが途切れる。
    """
    d = 1.8
    t = t_axis(d)
    up = (t / d) ** 1.6                       # 終わりに向かって上げる
    low = sine(sweep(55, 165, d, 1.8), d) * up * 0.9
    body = tone(220, d, (1.0, 0.5, 0.3, 0.15), 0.004) * up * 0.5
    air = highpass(noise(d, 31), 3000) * up * 0.35
    air *= 0.6 + 0.4 * np.sin(2 * np.pi * (3 + 9 * (t / d)) * t)  # 回転が速まる
    return lowpass(mix(low, body, air), 9000), 0.5


def sfx_gacha_open():
    """魔法陣が弾けて中身が出る瞬間。"""
    d = 1.1
    flash = highpass(noise(d, 37), 1800) * env_decay(d, 5.0) * 0.6
    hit = sine(sweep(320, 70, 0.35, 2.2), 0.35) * env_decay(0.35, 3.0)
    chime = mix(*[at(bell(f, d - 0.05) * g, 0.05, d) for f, g in
                  ((783.99, 1.0), (1046.5, 0.7), (1567.98, 0.45))])
    return reverb(mix(flash, at(hit, 0.0, d), chime), 1.0, 0.30, 41), 0.62


def sfx_gacha_rare():
    """上位品質が出た時だけ鳴らす。滅多に鳴らないので豪華に。

    discover(発見音)より一段派手にしたいが、同じ上がり方だと
    区別が付かない。こちらは和音を積み上げてから最後に高音を足す。
    """
    total = 2.4
    parts = []
    for i, f in enumerate((523.25, 659.25, 783.99, 1046.5)):   # C E G C
        s = 0.10 * i
        parts.append(at(bell(f, total - s) * (1 - i * 0.08), s, total))
    top = at(bell(2093.0, 1.4) * 0.8, 0.55, total)             # 最後の一撃
    shimmer = highpass(noise(total, 43), 6000) * env_decay(total, 1.2) * 0.14
    swell = sine(sweep(110, 220, 0.7, 1.5), 0.7) * env_ad(0.7, 0.2, 1.5) * 0.5
    x = mix(*parts, top, shimmer, at(swell, 0.0, total))
    return reverb(x, 1.4, 0.38, 47), 0.72


# ===== 鳥の声(ペットの孵化) =====
#
# 7種それぞれに別の声を作る。孵化は見せ場なので、
# 「何が生まれたか」を音だけでも分からせたい。似た声にしないこと。
#
# 鳴き分けの軸は3つ。
#   高さ … スズメ/ツバメは高い(3〜5kHz)。フクロウ/ハトは低い(350〜500Hz)
#   動き … さえずる鳥は周波数が速く上下する。鳴く鳥はほぼ一定
#   濁り … タカ/カラスは倍音を歪ませて濁らせる。他は澄ませる
#
# ★ サイン波1本では鳥にならない。必ず倍音を足すこと。
#   1本だけだと、どれだけ周波数を動かしても電子音の口笛にしか聞こえない。

def harsh(x, amount=3.0):
    """倍音を増やして濁らせる。猛禽やカラスの「割れた」声はこれで出る。"""
    return np.tanh(x * amount) / np.tanh(amount)


def vibrato(base, dur, rate, depth):
    """base[Hz] を rate[Hz] の速さで depth(比率)だけ揺らした周波数列。"""
    return base * (1 + depth * np.sin(2 * np.pi * rate * t_axis(dur)))


def chirp(f0, f1, dur, curve=1.0, attack=0.006, power=2.5):
    """一声ぶんの澄んださえずり。"""
    return sine(sweep(f0, f1, dur, curve), dur) * env_ad(dur, attack, power)


def sfx_bird_sparrow():
    """スズメ「チュン チュン」。短く高い声を2回。"""
    out = np.zeros(int(SR * 0.52))
    for i, (start, f0, f1) in enumerate([(0.0, 5200, 3400), (0.19, 5000, 3200)]):
        d = 0.10
        x = chirp(f0, f1, d, curve=0.55)
        x += 0.30 * sine(sweep(f0 * 2, f1 * 2, d, 0.55), d) * env_ad(d, 0.006, 3)
        s = int(SR * start)
        out[s:s + len(x)] += x * (1.0 - i * 0.12)
    return reverb(out, tail=0.35, amount=0.18), 0.45


def sfx_bird_lark():
    """ヒバリ「ピチュルピチュル」。長く細かくさえずり続ける。"""
    d = 1.10
    t = t_axis(d)
    # 速い上下に、ゆっくりした上昇を重ねる(一定だと機械の警報になる)
    f = 3200 + 900 * np.sin(2 * np.pi * 14 * t) + 600 * np.sin(2 * np.pi * 3.3 * t) + 500 * t
    x = sine(f, d) + 0.25 * sine(f * 2, d)
    # 粒立ちを出すため、細かく振幅を刻む
    x *= (0.55 + 0.45 * np.abs(np.sin(2 * np.pi * 7 * t))) * env_ad(d, 0.02, 1.2)
    return reverb(x, tail=0.5, amount=0.25), 0.42


def sfx_bird_swallow():
    """ツバメ「チュビチュビ」。速く細かい声を続けざまに。"""
    out = np.zeros(int(SR * 0.64))
    for i in range(4):
        d = 0.075
        f0 = 3400 + i * 250
        x = chirp(f0, f0 * 1.9, d, curve=1.6, attack=0.004, power=2.0)
        x += 0.22 * sine(sweep(f0 * 2, f0 * 3.8, d, 1.6), d) * env_ad(d, 0.004, 2.4)
        s = int(SR * (0.03 + i * 0.13))
        out[s:s + len(x)] += x * (1.0 - i * 0.12)
    return reverb(out, tail=0.35, amount=0.20), 0.42


def sfx_bird_owl():
    """フクロウ「ホー ホー」。低く柔らかい。高い倍音を削って丸くする。"""
    out = np.zeros(int(SR * 1.50))
    for i, start in enumerate([0.0, 0.62]):
        d = 0.52
        f = vibrato(360 if i == 0 else 340, d, 5.5, 0.02)
        x = sine(f, d) + 0.22 * sine(f * 2, d) + 0.06 * sine(f * 3, d)
        # 息を吹き込むような立ち上がりにする(鋭いと笛になる)
        x = lowpass(x * env_ad(d, 0.09, 2.2), 1400)
        s = int(SR * start)
        out[s:s + len(x)] += x
    return reverb(out, tail=1.1, amount=0.34), 0.55


def sfx_bird_hawk():
    """タカ「ピーヒョロロ」。高く始まり、震えながら降りてくる。"""
    d = 1.25
    t = t_axis(d)
    base = np.where(t < 0.35, 2050, 2050 - 950 * np.clip((t - 0.35) / (d - 0.35), 0, 1) ** 0.8)
    f = base * (1 + 0.055 * np.sin(2 * np.pi * 11 * t) * (t > 0.30))
    x = sine(f, d) + 0.50 * sine(f * 2, d) + 0.25 * sine(f * 3, d)
    x = harsh(x, 2.6)
    # かすれ。これが無いと澄みすぎて猛禽に聞こえない
    x += 0.10 * highpass(noise(d, 7), 2500) * env_ad(d, 0.02, 1.0)
    return reverb(x * env_ad(d, 0.03, 1.1), tail=0.9, amount=0.30), 0.50


def sfx_bird_dove():
    """ハト「クルッ クー」。低く丸い声。転がる前置きを付ける。"""
    out = np.zeros(int(SR * 1.35))
    d1 = 0.26                                   # 転がり(クルッ)
    f1 = vibrato(500, d1, 22, 0.10)
    x1 = (sine(f1, d1) + 0.30 * sine(f1 * 2, d1)) * env_ad(d1, 0.03, 1.6)
    out[:len(x1)] += lowpass(x1, 1800) * 0.80
    d2 = 0.62                                   # 伸ばし(クー)
    f2 = sweep(470, 430, d2)
    x2 = (sine(f2, d2) + 0.28 * sine(f2 * 2, d2) + 0.08 * sine(f2 * 3, d2)) * env_ad(d2, 0.10, 1.8)
    s = int(SR * 0.34)
    x2 = lowpass(x2, 1500)
    out[s:s + len(x2)] += x2
    return reverb(out, tail=0.9, amount=0.30), 0.52


def sfx_bird_crow():
    """カラス「カー カー」。濁った声を2回。"""
    out = np.zeros(int(SR * 1.15))
    for i, start in enumerate([0.0, 0.50]):
        d = 0.36
        f = sweep(780, 620, d, 0.7) * (1 + 0.04 * np.sin(2 * np.pi * 33 * t_axis(d)))
        x = sine(f, d) + 0.65 * sine(f * 2, d) + 0.40 * sine(f * 3, d) + 0.20 * sine(f * 5, d)
        x = harsh(x, 3.4)
        x += 0.16 * highpass(noise(d, 11 + i), 1200) * env_ad(d, 0.01, 1.4)
        s = int(SR * start)
        out[s:s + len(x)] += x * env_ad(d, 0.012, 1.5) * (1.0 - i * 0.15)
    return reverb(out, tail=0.7, amount=0.26), 0.50


def sfx_bird_bluebird():
    """アオイトリ「ピロリロ…」。ごく稀にしか出ない8種目。

    ★ 他の7種と作り方を変える。他は「鳥の声」だが、これだけは
      鈴の音を混ぜて、当たりを引いたと音で分かるようにする。
      同じ作りのまま音程だけ変えても、7種の中に埋もれる。
    """
    out = np.zeros(int(SR * 1.30))
    # 澄んださえずり。上がって下りる三音
    for i, (start, f0, f1) in enumerate([(0.00, 2600, 3400), (0.16, 3400, 4200),
                                         (0.34, 4200, 3000)]):
        d = 0.16
        x = chirp(f0, f1, d, curve=0.8, attack=0.008, power=2.2)
        x += 0.35 * sine(sweep(f0 * 1.5, f1 * 1.5, d, 0.8), d) * env_ad(d, 0.008, 2.6)
        s = int(SR * start)
        out[s:s + len(x)] += x * (0.9 + i * 0.05)
    # 鈴。倍音が整数比から少しずれた音を重ねると鈴らしくなる
    d2 = 0.85
    鈴 = np.zeros(int(SR * d2))
    for f, a in [(2093, 1.0), (3140, 0.55), (4700, 0.32), (6280, 0.18)]:
        鈴 += a * sine(f, d2) * env_decay(d2, 2.2)
    s = int(SR * 0.30)
    out[s:s + len(鈴)] += 鈴 * 0.5
    return reverb(out, tail=1.2, amount=0.38), 0.50


ALL = {
    'select': sfx_select, 'unselect': sfx_unselect, 'click': sfx_click,
    'crafting': sfx_crafting, 'craft': sfx_craft, 'craftFail': sfx_craft_fail,
    'gathering': sfx_gathering, 'gather': sfx_gather,
    'transmuting': sfx_transmuting, 'transmute': sfx_transmute,
    'discover': sfx_discover,
    'casting': sfx_casting, 'cast': sfx_cast, 'enemyCast': sfx_enemy_cast,
    'hit': sfx_hit, 'crit': sfx_crit, 'damage': sfx_damage, 'defeat': sfx_defeat,
    'heal': sfx_heal, 'shield': sfx_shield, 'buff': sfx_buff, 'quake': sfx_quake,
    'countdown': sfx_countdown, 'start': sfx_start,
    # 勝利音は C 勝鬨 を採用(2026-08-02)。
    # 旧版の sfx_win() も残してあるので、ここを戻せば元の音に復帰できる。
    'win': sfx_win_c, 'lose': sfx_lose, 'escape': sfx_escape,
    'gachaCharge': sfx_gacha_charge, 'gachaOpen': sfx_gacha_open,
    'gachaRare': sfx_gacha_rare,
    # 鳥の声(ペットの孵化)。名前は shared/pets.ts の種類の id に揃えてある ―
    # 画面側は playSfx('bird_' + species) で引けるようにするため。
    'bird_sparrow': sfx_bird_sparrow, 'bird_lark': sfx_bird_lark,
    'bird_swallow': sfx_bird_swallow, 'bird_owl': sfx_bird_owl,
    'bird_hawk': sfx_bird_hawk, 'bird_dove': sfx_bird_dove,
    'bird_crow': sfx_bird_crow, 'bird_bluebird': sfx_bird_bluebird,
}


# 節ごとの見出しと、そこへ入れる音。ここに無い音は「その他」へ回る。
#
# ★ 音を足したらここへ1行足すこと。書き忘れても「その他」に必ず出る。
#   以前は試聴ページを手で書いていたため、鳥の声を8種作ったのに
#   1種もページに載らず、遊ぶ人に「アオイトリが無い」と言われて気づいた。
AUDITION_SECTIONS = [
    ('研究室', ['select', 'unselect', 'click', 'crafting', 'craft', 'craftFail',
              'gathering', 'gather', 'transmuting', 'transmute', 'discover']),
    ('戦闘', ['casting', 'cast', 'enemyCast', 'hit', 'crit', 'damage', 'defeat',
            'heal', 'shield', 'buff', 'quake', 'countdown', 'start',
            'win', 'lose', 'escape']),
    ('ガチャ', ['gachaCharge', 'gachaOpen', 'gachaRare']),
    ('ペットの鳥(孵化)', ['bird_sparrow', 'bird_lark', 'bird_swallow', 'bird_owl',
                  'bird_hawk', 'bird_dove', 'bird_crow', 'bird_bluebird']),
]

# 説明文。無いものは名前だけ出す。
AUDITION_DESC = {
    'bird_sparrow': 'スズメ「チュン チュン」と短く2回',
    'bird_lark': 'ヒバリ 長くさえずり続ける',
    'bird_swallow': 'ツバメ 速く細かく4回',
    'bird_owl': 'フクロウ「ホー ホー」低く柔らかい',
    'bird_hawk': 'タカ「ピーヒョロロ」震えながら降りる',
    'bird_dove': 'ハト「クルッ クー」低く丸い',
    'bird_crow': 'カラス「カー カー」濁った声',
    'bird_bluebird': 'アオイトリ ごく稀。鈴の音が混ざる',
}

LOOP_SOUNDS = {'crafting', 'gathering', 'transmuting', 'casting'}


def write_audition():
    """試聴ページを作り直す。置かれている音は必ず載る。"""
    import html
    if not os.path.isdir(SFX_DIR):
        return
    ある = [os.path.splitext(f)[0] for f in sorted(os.listdir(SFX_DIR))
           if f.lower().endswith('.wav')]
    載せた = set()
    節 = []
    for 見出し, keys in AUDITION_SECTIONS:
        含む = [k for k in keys if k in ある]
        if not 含む:
            continue
        載せた.update(含む)
        節.append((見出し, 含む))
    残り = [k for k in ある if k not in 載せた]
    if 残り:
        節.append(('その他(節に割り振られていない音)', 残り))

    行 = []
    for 見出し, keys in 節:
        行.append('<section>')
        行.append('  <h2>' + html.escape(見出し) + '</h2>')
        for k in keys:
            ループ = k in LOOP_SOUNDS
            名 = ('🔁 ' if ループ else '') + k
            desc = html.escape(AUDITION_DESC.get(k, ''))
            cls = ' loop' if ループ else ''
            lp = ' loop' if ループ else ''
            行.append(
                '  <div class="row"><span class="nm' + cls + '">'
                + html.escape(名) + '</span><span class="desc">' + desc
                + '</span><audio controls preload="none"' + lp
                + ' src="' + k + '.wav"></audio></div>')
        行.append('</section>')

    head = (
        '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n'
        '<title>効果音 試聴 — 魔導研究記</title>\n<style>\n'
        '  body { background:#12121e; color:#ddddee; font-family:"Meiryo",sans-serif;\n'
        '         margin:0; padding:24px; line-height:1.7; }\n'
        '  h1 { font-size:20px; color:#ddccff; margin:0 0 4px; }\n'
        '  .note { font-size:13px; color:#8888aa; margin:0 0 18px; }\n'
        '  section { background:#1a1a2c; border:1px solid #33335a; border-radius:10px;\n'
        '            padding:14px 16px; margin-bottom:16px; }\n'
        '  h2 { font-size:15px; color:#aaaacc; margin:0 0 10px; }\n'
        '  .row { display:flex; align-items:center; gap:12px; padding:4px 0; flex-wrap:wrap; }\n'
        '  .nm { width:150px; flex:none; color:#ffdd66; font-size:13px; }\n'
        '  .nm.loop { color:#88ddff; }\n'
        '  .desc { flex:1; min-width:180px; font-size:12px; color:#9999bb; }\n'
        '  audio { width:260px; flex:none; }\n'
        '</style>\n</head>\n<body>\n<h1>効果音 試聴</h1>\n'
        '<p class="note">このページは tools/soundgen/gen_sfx.py が作ります。'
        '手で編集しないでください(音を足しても載らない、という取りこぼしを防ぐため)。'
        '全' + str(len(ある)) + '種。</p>\n')
    doc = head + '\n'.join(行) + '\n</body>\n</html>\n'

    path = os.path.join(SFX_DIR, '_試聴.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(doc)
    print('_試聴.html を作り直した(全' + str(len(ある)) + '種 / ' + str(len(節)) + '節)。')


def write_manifest():
    """置かれている音を manifest.json に登録する(BGMの登録は残す)。"""
    import json
    path = os.path.join(SOUND_DIR, 'manifest.json')
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            m = json.load(f)
    sfx = {}
    if os.path.isdir(SFX_DIR):
        for f in sorted(os.listdir(SFX_DIR)):
            base, ext = os.path.splitext(f)
            if ext.lower() not in ('.wav', '.mp3', '.ogg', '.m4a'):
                continue
            if True:
                sfx[base] = f'sfx/{f}'
    if sfx:
        m['sfx'] = sfx
    else:
        m.pop('sfx', None)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print(f'manifest.json を更新した(効果音 {len(sfx)}個)。')
    write_audition()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='hit / cast など')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--manifest', action='store_true')
    args = ap.parse_args()

    if args.manifest:
        write_manifest()
        return
    if not args.only and not args.all:
        ap.error('--only か --all か --manifest を指定する')

    names = [args.only] if args.only else list(ALL)
    for n in names:
        if n not in ALL:
            ap.error(f'不明な効果音: {n}')
    print(f'{len(names)}種を合成する…')
    for n in names:
        x, peak = ALL[n]()
        save(n, x, peak)
    write_manifest()


if __name__ == '__main__':
    main()
