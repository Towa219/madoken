# 鳥の声が本当に鳴き分けられているかを測る。
#
#   python measure_birds.py
#
# 耳で確かめる前に、狙った3つの軸で実際に差が付いているかを数字で見る。
#   高さ … 声の中心の高さ(重心)。スズメ/ツバメは高く、フクロウ/ハトは低いはず
#   動き … 高さがどれだけ上下したか。さえずる鳥は大きく、鳴く鳥は小さいはず
#   濁り … 倍音の広がり。タカ/カラスは大きく、他は小さいはず
#
# ★ 「別の音になっている」ことまでは測れるが、「鳥に聞こえる」かは測れない。
#   最後は必ず耳で確かめること。

import os
import sys
import wave

import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
SFX_DIR = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'sound', 'sfx'))

BIRDS = [
    ('bird_sparrow', 'スズメ', '高い'), ('bird_lark', 'ヒバリ', '高い'),
    ('bird_swallow', 'ツバメ', '高い'), ('bird_owl', 'フクロウ', '低い'),
    ('bird_hawk', 'タカ', '中'), ('bird_dove', 'ハト', '低い'),
    ('bird_crow', 'カラス', '中'), ('bird_bluebird', 'アオイトリ', '高い'),
]


def read_wav(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype='<i2').astype(float) / 32768.0, sr


def frames(x, sr, win=2048, hop=512):
    """窓ごとのスペクトルを返す。鳴っている所だけ。"""
    out = []
    w = np.hanning(win)
    for i in range(0, len(x) - win, hop):
        seg = x[i:i + win]
        if np.sqrt(np.mean(seg ** 2)) < 0.02:   # 無音は数えない
            continue
        out.append(np.abs(np.fft.rfft(seg * w)))
    if not out:
        return None, None
    return np.array(out), np.fft.rfftfreq(win, 1 / sr)


def onsets(x, sr):
    """声を何回に区切って出しているか。さえずりの「粒」の数。

    ★ 高さと濁りだけでは、スズメ・ヒバリ・ツバメのような
      小鳥どうしを区別できない。実際この3種を隔てているのは
      高さではなく「短く何回鳴くか」なので、そこを測る。
    """
    win = 512
    env = np.array([np.sqrt(np.mean(x[i:i + win] ** 2))
                    for i in range(0, len(x) - win, win)])
    if not len(env):
        return 0
    高 = np.max(env) * 0.35
    低 = np.max(env) * 0.15
    数, 鳴っている = 0, False
    for v in env:                      # 高い所で入り、低い所で抜ける(揺れで重複して数えない)
        if not 鳴っている and v > 高:
            数 += 1
            鳴っている = True
        elif 鳴っている and v < 低:
            鳴っている = False
    return 数


def measure(path):
    x, sr = read_wav(path)
    spec, freq = frames(x, sr)
    if spec is None:
        return None

    # ★ 声の高さは「重心」ではなく「一番強い山」で測る。
    #   重心は歪みで増えた倍音に引きずられる。タカを歪ませた時、
    #   狙いは2050→1100Hzなのに重心は6330Hzと出た(実測)。
    山 = freq[np.argmax(spec, axis=1)]

    # 濁りも、その窓の山を基準にして測る。「2500Hzより上」で測ると、
    #   もともと高い声のスズメが自動的に濁り1.00になってしまう(実測)。
    濁り一覧 = []
    for i in range(len(spec)):
        f0 = max(山[i], 1e-9)
        上 = spec[i][freq > f0 * 2.5].sum()
        濁り一覧.append(上 / max(spec[i].sum(), 1e-9))

    return {
        '長さ': len(x) / sr,
        '高さ': float(np.median(山)),
        '動き': float(np.percentile(山, 90) - np.percentile(山, 10)),
        '濁り': float(np.median(濁り一覧)),
        '粒': onsets(x, sr),
        '最大': float(np.max(np.abs(x))),
    }


def main():
    print('=== 鳥の声を測る ===')
    print(f'{"種類":<8}{"長さ":>7}{"高さ(Hz)":>11}{"動き(Hz)":>11}{"濁り":>8}{"粒":>5}{"最大":>7}')
    rows = []
    for key, name, _ in BIRDS:
        path = os.path.join(SFX_DIR, f'{key}.wav')
        if not os.path.exists(path):
            print(f'{name:<8}  ファイルが無い')
            continue
        m = measure(path)
        rows.append((name, m))
        print(f'{name:<8}{m["長さ"]:>6.2f}秒{m["高さ"]:>11.0f}{m["動き"]:>11.0f}'
              f'{m["濁り"]:>8.2f}{m["粒"]:>5}{m["最大"]:>7.2f}')

    print()
    ng = 0
    # 高さの並びが狙い通りか
    h = {n: m['高さ'] for n, m in rows}
    for 上, 下 in [('スズメ', 'フクロウ'), ('ツバメ', 'ハト'), ('ヒバリ', 'カラス')]:
        ok = h.get(上, 0) > h.get(下, 0)
        print(f'  {"OK " if ok else "NG "} {上} は {下} より高い'
              f'({h.get(上, 0):.0f} と {h.get(下, 0):.0f})')
        if not ok:
            ng += 1
    # 濁りが狙い通りか
    d = {n: m['濁り'] for n, m in rows}
    for 濁, 澄 in [('カラス', 'ハト'), ('タカ', 'フクロウ')]:
        ok = d.get(濁, 0) > d.get(澄, 1)
        print(f'  {"OK " if ok else "NG "} {濁} は {澄} より濁っている'
              f'({d.get(濁, 0):.2f} と {d.get(澄, 0):.2f})')
        if not ok:
            ng += 1
    # さえずる鳥は高さがよく動くか
    mv = {n: m['動き'] for n, m in rows}
    for さえずり, 鳴き in [('ヒバリ', 'フクロウ'), ('ツバメ', 'ハト')]:
        ok = mv.get(さえずり, 0) > mv.get(鳴き, 1)
        print(f'  {"OK " if ok else "NG "} {さえずり} は {鳴き} より高さが動く'
              f'({mv.get(さえずり, 0):.0f} と {mv.get(鳴き, 0):.0f})')
        if not ok:
            ng += 1

    # 7種が互いに十分離れているか。
    # 高さ・濁り・粒の数・長さ、どれか1つで離れていれば聞き分けられる。
    print()
    近い = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            n1, m1 = rows[i]
            n2, m2 = rows[j]
            高さが近い = max(m1['高さ'], m2['高さ']) / max(min(m1['高さ'], m2['高さ']), 1e-9) < 1.25
            濁りが近い = abs(m1['濁り'] - m2['濁り']) < 0.10
            粒が近い = abs(m1['粒'] - m2['粒']) < 2
            長さが近い = abs(m1['長さ'] - m2['長さ']) < 0.35
            if 高さが近い and 濁りが近い and 粒が近い and 長さが近い:
                近い.append(f'{n1}と{n2}')
    if 近い:
        print(f'  NG  聞き分けにくい組み合わせ: {", ".join(近い)}')
        ng += 1
    else:
        print('  OK  7種すべてが高さか濁りで離れている')

    print()
    print('=== 合格 ===' if ng == 0 else f'=== {ng}件 直すところがある ===')
    return 0 if ng == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
