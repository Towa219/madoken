# -*- coding: utf-8 -*-
"""撮影済みのVidu素材から、まどけんPV第2版を編集する。"""

import argparse
import json
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

SOURCE_DIR = os.path.join(HERE, "out_vidu")
CLIP_DIR = os.path.join(HERE, "clip_vidu")
OVERLAY_DIR = os.path.join(HERE, "overlay_vidu")
OUTPUT = os.path.join(HERE, "madoken_pv2.mp4")
BGM = os.path.join(HERE, "bgm", "Sign-of-Victory.mp3")
BGM_START = 40.0
FPS = 24
END_LEN = 4.6


def energy_volume():
    """台本の energy どおりに曲の音量を動かす ffmpeg の指定を作る。

    ★ 曲を選ぶだけでは合わない(2026-08-11)。
      ACE-Step は「15秒で落として20秒で最高潮」といった時刻を指定できない。
      9曲作って一番良いものでも、狙いの曲線との相関は +0.43 止まりだった。
      選ぶのをやめて、こちらで音量を作る。苦戦で引き、合体魔法で最大になる
      ことが偶然ではなく保証される。

    ★ 音量は energy をそのまま使わず 0.45〜1.0 に写す。
      0.2 をそのまま掛けると聞こえなくなり、曲が切れたように感じる。
      落とすのは「引く」ためであって「止める」ためではない。
    ★ カットの境で音量が階段状に跳ぶと、切り替わりのたびに耳に付く。
      境の前後 0.35秒をまたいで滑らかに渡す。
    ★ 曲は ACE-Step ではなく市販素材を使う(2026-08-11に差し戻し)。
      ACE-Step(turbo)で9曲作ったが、低音が市販素材の半分(9.0% 対 17.3%)、
      超高域が3倍(22.1% 対 7.9%)で、「発音数が少ない・低音がない・
      高域が割れて聞こえる」という指摘どおりの偏りが数字にも出た。
      曲の質は生成では届かない。素材の良さを土台にして、
      合わせ込みだけをこちらでやる。
    """
    lo, hi = 0.45, 1.0
    span = 0.35
    points = []
    t = 0.0
    for cut in CUTS:
        gain = lo + (hi - lo) * float(cut.get("energy", 0.7))
        points.append((t, t + cut["trim"], gain))
        t += cut["trim"]

    # ffmpeg の volume は式で書ける。t(秒)から目標の倍率を作る。
    # 区間の境は線形に渡す(1つ前の倍率から次の倍率へ span 秒かけて動かす)。
    terms = []
    for i, (start, end, gain) in enumerate(points):
        if i == 0:
            terms.append(f"{gain:.3f}")
            continue
        prev = points[i - 1][2]
        # start-span/2 から start+span/2 のあいだで prev → gain へ
        a = start - span / 2
        terms.append(
            f"+lt(t,{a:.3f})*0"
            f"+between(t,{a:.3f},{a + span:.3f})*({gain - prev:.3f})"
            f"*(t-{a:.3f})/{span:.3f}"
            f"+gt(t,{a + span:.3f})*({gain - prev:.3f})")
    # ★ dynaudnorm は掛けないこと(2026-08-11)。
    #   ACE-Step の曲を平坦化するために入れたが、市販素材に掛けると
    #   小さい所を持ち上げてノイズと高域の粗さが出る。
    #   元から整っている曲は、音量カーブだけで十分に山が作れる。
    return "volume='" + "".join(terms) + "':eval=frame,"


def bgm_choice():
    """選定JSONがあれば第2版曲を、なければ従来の第1版曲を返す。"""
    choice_path = os.path.join(HERE, "bgm_choice.json")
    if not os.path.exists(choice_path):
        return BGM, BGM_START
    try:
        with open(choice_path, encoding="utf-8") as file:
            choice = json.load(file)
        selected = choice["file"]
        if not os.path.isabs(selected):
            selected = os.path.join(HERE, selected)
        offset = float(choice["offset"])
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"BGM選定JSONを読み込めません: {choice_path}: {exc}") from exc
    if offset < 0:
        raise ValueError("BGMの開始位置は0秒以上である必要があります")
    return os.path.normpath(selected), offset


def ffmpeg_path():
    path = shutil.which("ffmpeg")
    if path:
        return path
    candidates = [
        r"C:\Program Files\TuneFab\ffmpeg.exe",
        (r"C:\Users\ai_to\AppData\Local\Microsoft\WinGet\Packages"
         r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
         r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    raise SystemExit("ffmpegが見つかりません")


def ffprobe_path():
    head, tail = os.path.split(ffmpeg_path())
    return os.path.join(head, tail.replace("ffmpeg", "ffprobe", 1))


def duration(path):
    result = subprocess.run(
        [ffprobe_path(), "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=True)
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError(f"動画の実尺を取得できませんでした: {path}") from exc


def trim_start(actual, wanted, keep):
    if actual + 0.001 < wanted:
        raise ValueError(f"元動画の実尺{actual:.3f}秒が完成尺{wanted:.3f}秒より短いです")
    if keep == "head":
        return 0.0
    if keep == "tail":
        return actual - wanted
    if keep == "mid":
        return (actual - wanted) / 2
    raise ValueError(f"未対応のkeep指定です: {keep}")


def cmd_trim():
    os.makedirs(CLIP_DIR, exist_ok=True)
    ff = ffmpeg_path()
    for cut in CUTS:
        source = os.path.join(SOURCE_DIR, f"{cut['id']}_take1_1.mp4")
        if not os.path.exists(source):
            raise FileNotFoundError(f"撮影済み動画が見つかりません: {source}")
        actual = duration(source)
        wanted = float(cut["trim"])
        start = trim_start(actual, wanted, cut["keep"])
        output = os.path.join(CLIP_DIR, f"{cut['id']}.mp4")
        # 逆再生の指定があれば、切り出す前に丸ごと反転する。
        # ★ 切り出してから反転してはいけない。keep は「完成品のどこを残すか」
        #   なので、反転後の時間軸で切らないと頭と尻が入れ替わる。
        reverse = bool(cut.get("reverse"))
        print(f"{cut['id']}: 実尺{actual:.3f}秒 / 開始位置{start:.3f}秒 / "
              f"完成尺{wanted:.3f}秒 / keep={cut['keep']}"
              f"{' / 逆再生' if reverse else ''}")
        command = [ff, "-y", "-hide_banner", "-loglevel", "error"]
        if reverse:
            command += ["-i", source, "-vf", "reverse",
                        "-ss", f"{start:.6f}", "-t", f"{wanted:.6f}"]
        else:
            command += ["-ss", f"{start:.6f}", "-i", source, "-t", f"{wanted:.6f}"]
        command += ["-an", "-c:v", "libx264", "-crf", "18", "-r", str(FPS),
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]
        subprocess.run(command, check=True)


def cmd_join():
    clips = [os.path.join(CLIP_DIR, f"{cut['id']}.mp4") for cut in CUTS]
    missing = [path for path in clips if not os.path.exists(path)]
    if missing:
        raise FileNotFoundError("結合するクリップが不足しています: " + ", ".join(missing))

    os.makedirs(CLIP_DIR, exist_ok=True)
    list_path = os.path.join(CLIP_DIR, "_list.txt")
    with open(list_path, "w", encoding="utf-8") as file:
        for clip in clips:
            file.write("file '" + os.path.abspath(clip).replace("'", "'\\''") + "'\n")

    total = sum(float(cut["trim"]) for cut in CUTS)
    title_seq = os.path.join(OVERLAY_DIR, "title_seq", "%04d.png")
    end = os.path.join(OVERLAY_DIR, "end.png")
    has_text = os.path.isdir(os.path.dirname(title_seq)) and os.path.exists(end)
    bgm, bgm_start = bgm_choice()
    has_bgm = os.path.exists(bgm)
    if os.path.exists(os.path.join(HERE, "bgm_choice.json")) and not has_bgm:
        raise FileNotFoundError(f"選定されたBGMが見つかりません: {bgm}")

    command = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", list_path]
    if has_bgm:
        # 曲は途中から切り出す。頭は0.6秒で入り、終わりは1.8秒かけて引く。
        # 曲の途中でぶつ切りにすると、切れた瞬間が耳に付くためである。
        command += ["-ss", f"{bgm_start:.2f}", "-t", f"{total:.2f}", "-i", bgm]
    if has_text:
        # 題字は1コマずつ描いた連番PNGである。1枚絵の座標を整数単位で動かすと
        # カクつくため、拡大縮小と出入りを各PNGへ焼き込んでから重ねる。
        command += ["-framerate", str(FPS), "-i", title_seq,
                    "-loop", "1", "-i", end]

    chains = []
    video_output = "0:v"
    if has_text:
        title_input = 2 if has_bgm else 1
        end_input = title_input + 1
        end_start = max(0.0, total - END_LEN)
        chains += [
            f"[{title_input}:v]format=rgba[t]",
            f"[{end_input}:v]format=rgba,fade=in:st={end_start:.2f}:d=1.0:alpha=1[e]",
            "[0:v][t]overlay=x=0:y=0:eof_action=pass[v1]",
            "[v1][e]overlay=x=0:y=0[v]",
        ]
        video_output = "v"
    if has_bgm:
        chains.append(f"[1:a]{energy_volume()}afade=t=in:st=0:d=0.6,"
                      f"afade=t=out:st={total - 1.8:.2f}:d=1.8[a]")
    if chains:
        command += ["-filter_complex", ";".join(chains)]
    command += ["-map", f"[{video_output}]" if video_output == "v" else video_output]
    if has_bgm:
        command += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    command += ["-shortest", "-c:v", "libx264", "-crf", "18", "-r", str(FPS),
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUTPUT]
    subprocess.run(command, check=True)
    if has_bgm:
        print(f"使用BGM {bgm} / 開始位置 {bgm_start:.2f}秒")
    print(f"カット数 {len(clips)} / 合計尺 {duration(OUTPUT):.3f}秒 / 出力先 {OUTPUT}")


def main():
    parser = argparse.ArgumentParser(description="まどけんPV第2版の編集ツール")
    parser.add_argument("command", choices=("trim", "join", "all"), help="実行する処理")
    args = parser.parse_args()
    if args.command in ("trim", "all"):
        cmd_trim()
    if args.command in ("join", "all"):
        cmd_join()


if __name__ == "__main__":
    main()
