# -*- coding: utf-8 -*-
"""PV第2版の映像エネルギーに最も合うBGMと開始位置を数値で選ぶ。"""

import argparse
import array
import glob
import json
import math
import os
import shutil
import subprocess
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from vidu_cuts import CUTS

WINDOW = 0.05
OFFSET_STEP = 0.1
SAMPLE_RATE = 16000
CHOICE_PATH = os.path.join(HERE, "bgm_choice.json")


def ffmpeg_path():
    found = shutil.which("ffmpeg")
    candidates = [
        found,
        r"C:\Program Files\TuneFab\ffmpeg.exe",
        (r"C:\Users\ai_to\AppData\Local\Microsoft\WinGet\Packages"
         r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
         r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"),
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    raise SystemExit("ffmpegが見つかりません")


def target_curve():
    values = []
    spans = []
    cursor = 0
    for cut in CUTS:
        count = int(round(float(cut["trim"]) / WINDOW))
        start = cursor
        values.extend([float(cut["energy"])] * count)
        cursor += count
        spans.append((cut, start, cursor))
    return values, spans


def audio_envelope(path):
    command = [ffmpeg_path(), "-v", "error", "-i", path, "-vn", "-ac", "1",
               "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    result = subprocess.run(command, capture_output=True, check=True)
    samples = array.array("f")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    size = int(SAMPLE_RATE * WINDOW)
    rms = []
    for start in range(0, len(samples) - size + 1, size):
        block = samples[start:start + size]
        rms.append(math.sqrt(sum(value * value for value in block) / size))
    if not rms or max(rms) <= 0:
        raise RuntimeError(f"音量を解析できません: {path}")
    # ごく短いピークへの過敏さを避けつつ、曲内の静動を0〜1へ写す。
    ordered = sorted(rms)
    floor = ordered[int((len(ordered) - 1) * 0.05)]
    ceiling = ordered[int((len(ordered) - 1) * 0.95)]
    width = max(ceiling - floor, 1e-12)
    return [max(0.0, min(1.0, (value - floor) / width)) for value in rms]


def correlation(left, right):
    lm = sum(left) / len(left)
    rm = sum(right) / len(right)
    numerator = sum((a - lm) * (b - rm) for a, b in zip(left, right))
    ld = sum((a - lm) ** 2 for a in left)
    rd = sum((b - rm) ** 2 for b in right)
    denominator = math.sqrt(ld * rd)
    return numerator / denominator if denominator else -1.0


def evaluate(path, target, spans):
    envelope = audio_envelope(path)
    needed = len(target)
    max_start = len(envelope) - needed
    if max_start < 0:
        raise RuntimeError(f"曲が映像尺より短いです: {path}")
    step = max(1, int(round(OFFSET_STEP / WINDOW)))
    best = None
    for start in range(0, max_start + 1, step):
        actual = envelope[start:start + needed]
        corr = correlation(target, actual)
        rmse = math.sqrt(sum((a - b) ** 2 for a, b in zip(target, actual)) / needed)
        cut_values = [sum(actual[a:b]) / (b - a) for _, a, b in spans]
        loudness_order = sorted(range(len(cut_values)),
                                key=lambda index: cut_values[index], reverse=True)
        climax_rank = loudness_order.index(12) + 1
        struggle_rank = loudness_order.index(9) + 1
        # 演出上の必須条件を満たす区間が一つでもあれば、それを優先する。
        # 15カット中、合体魔法は上位5、苦戦は下位5を合格とする。
        qualified = climax_rank <= 5 and struggle_rank >= 11
        rank = (qualified, corr, -rmse)
        if best is None or rank > best[0]:
            best = (rank, start * WINDOW, corr, rmse, cut_values,
                    qualified, climax_rank, struggle_rank)
    return best[1:]


def display(results, spans):
    print("\n候補曲の選定結果（演出条件を優先、次に相関の高い順）")
    print("順位  曲名                            開始秒    相関    RMSE  演出条件")
    for rank, item in enumerate(results, 1):
        print(f"{rank:>4}  {os.path.basename(item['file']):<30} "
              f"{item['offset']:>6.2f}  {item['correlation']:>6.3f}  {item['rmse']:>6.3f}  "
              f"{'合格' if item['qualified'] else '未達'}")
    winner = results[0]
    print(f"\n採用: {os.path.basename(winner['file'])} / 開始 {winner['offset']:.2f}秒")
    print("カット別: カット名                 狙い  実音量")
    for (cut, _, _), actual in zip(spans, winner["cuts"]):
        print(f"          {cut['id']:<22} {float(cut['energy']):>4.2f}  {actual:>6.3f}")
    by_id = {cut["id"]: actual for (cut, _, _), actual in zip(spans, winner["cuts"])}
    print(f"\n重点確認 13_合体魔法: {by_id['13_合体魔法']:.3f}（狙い 1.00）")
    print(f"重点確認 10_苦戦:     {by_id['10_苦戦']:.3f}（狙い 0.35）")
    print(f"音量順位 13_合体魔法: {winner['climax_rank']}位 / 15カット")
    print(f"音量順位 10_苦戦:     {winner['struggle_rank']}位 / 15カット")


def main():
    parser = argparse.ArgumentParser(description="PV第2版に合うBGM区間を自動選定します")
    parser.add_argument("files", nargs="*", help="候補音声。省略時はbgm/pv_v2_*.mp3")
    args = parser.parse_args()
    files = args.files or sorted(glob.glob(os.path.join(HERE, "bgm", "pv_v2_*.mp3")))
    files = [os.path.abspath(path) for path in files]
    if not files:
        raise SystemExit("候補曲がありません。先にpv_bgm.py --set v2を実行してください")
    target, spans = target_curve()
    results = []
    for path in files:
        print(f"解析中: {os.path.basename(path)}")
        offset, corr, rmse, cuts, qualified, climax_rank, struggle_rank = evaluate(
            path, target, spans)
        results.append({"file": path, "offset": offset, "correlation": corr,
                        "rmse": rmse, "cuts": cuts, "qualified": qualified,
                        "climax_rank": climax_rank, "struggle_rank": struggle_rank})
    results.sort(key=lambda item: (item["qualified"], item["correlation"],
                                   -item["rmse"]), reverse=True)
    display(results, spans)
    relative = os.path.relpath(results[0]["file"], HERE).replace(os.sep, "/")
    with open(CHOICE_PATH, "w", encoding="utf-8") as file:
        json.dump({"file": relative, "offset": round(results[0]["offset"], 2)},
                  file, ensure_ascii=False, indent=2)
        file.write("\n")
    print(f"\n選定結果を書き込みました: {CHOICE_PATH}")


if __name__ == "__main__":
    main()
