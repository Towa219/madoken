# 画像素材ジェネレータ

ローカルの **ComfyUI** で `public/img/` の画像を作り直すための道具。
生成 → 背景透過 → 大きさ調整 → `manifest.json` 更新 までを一括で行う。

道具は2本ある。**今のキャラクターは gen_poses.py で作られている。**

| 道具 | モデル | 作るもの |
|---|---|---|
| `gen_poses.py` | FLUX.1 schnell | 味方5体・敵14種 × 4ポーズ = 76枚(**現行**) |
| `gen.py` | Animagine XL 4.0 | 弾8種・戦闘背景。キャラも作れる(旧版・v0.52.0まで) |

## ポーズ(gen_poses.py)

1体につき4枚。`idle` は今までどおりの名前、他は `_cast` などが付く。

| ポーズ | いつ出るか | ファイル名 |
|---|---|---|
| idle | 待機 | `player/1.png` `enemy/blob.png` |
| cast | 詠唱中 | `player/1_cast.png` |
| release | 魔法が完成して撃った・盾を張った | `player/1_release.png` |
| hurt | ダメージを受けた | `player/1_hurt.png` |

```
python gen_poses.py --only player:1        1体4枚だけ試す
python gen_poses.py --only player:1:cast   1枚だけ引き直す
python gen_poses.py --only enemy:blob --seed 12345
python gen_poses.py --all                  全76枚(約15分)
python gen_poses.py --shrink               減色して軽くする(8.4MB→1.4MB)
python gen_poses.py --manifest             manifest.json だけ作り直す
python pose_sheet.py                       ポーズを横一列に並べた一覧を作る
```

**`--all` のあとは必ず `--shrink` を実行すること。** ポーズで枚数が4倍になり、
そのままだと絵だけで 9MB を超える。セル塗りなので減色しても見た目は変わらない。

### FLUX で引っかかったこと

- **姿の説明と seed は4枚で完全に同じにする。** 末尾のポーズ文だけを差し替える。
  FLUX は文が変わると絵がまるごと変わるので、揃えられるのはここだけ。
- **光り物(ウィスプ)は白背景で描かせてはいけない。** 光ではなく影として描かれ、
  切り抜くと黒い塊しか残らない。`"cut": "luma"` にして黒背景で描かせる。
  このとき**白背景の指定が1語でも残っていると白い四角がそのまま残る**
  (一覧では白背景と見分けがつかず、戦闘画面に出して初めて気づく)。
- **「前に魔法陣」はウィスプに使えない。** 本体と離れた輪が別に描かれ、絵が片側に
  寄って頭上のHPバーが本体から外れる。`poses` でその子だけ文を差し替える。
- **被弾のポーズは上半身だけの構図になることがある。** 高さを揃えて表示するので、
  そのままだと顔だけが巨大に映る。`seeds` でそのポーズだけ引き直した種を固定する。

出来上がりは自動で点検する(暗すぎる・中身が空・構図が待機と違いすぎる・
左右に寄りすぎ・切り抜き失敗)。警告が出たら seed を変えて引き直す。

## 元に戻す

```
powershell -ExecutionPolicy Bypass -File ..\art_rollback.ps1
```

`tools/artgen/art_v1/` に v0.52.0 時点(Animagine XL 製)の絵を退避してある。
ポーズ絵を消して元の19枚に戻す。戻したあとは `npm run build` を忘れずに。

---

## 以下は gen.py(弾・背景・旧キャラ)の説明

## 前提

| もの | 場所 |
|---|---|
| ComfyUI(ポータブル版) | `D:\ComfyUI` |
| モデル | `D:\ComfyUI\ComfyUI\models\checkpoints\animagine-xl-4.0-opt.safetensors` |
| 背景透過などの道具 | `D:\ComfyUI\_tools`(ComfyUI 本体の環境は汚さない) |

場所を変えた場合は環境変数 `COMFY_URL` `COMFY_CKPT` `ARTGEN_TOOLS` で指定できる。

## 使い方

ComfyUI を起動しておく:

```
D:\ComfyUI\python_embeded\python.exe -s D:\ComfyUI\ComfyUI\main.py --disable-auto-launch --port 8188
```

そのうえで:

```
D:\ComfyUI\python_embeded\python.exe gen.py --only player       1枚だけ試す
D:\ComfyUI\python_embeded\python.exe gen.py --only enemy:blob
D:\ComfyUI\python_embeded\python.exe gen.py --only proj:fire
D:\ComfyUI\python_embeded\python.exe gen.py --all               全24枚
D:\ComfyUI\python_embeded\python.exe gen.py --manifest          manifest.json だけ作り直す
D:\ComfyUI\python_embeded\python.exe sheet.py                   出来を一覧で確認
```

`--seed` を変えると別の絵になる。気に入らなければ seed を変えて引き直す。

## 絵の内容を変える

`subjects.json` を編集する。

- `player.prompt` の先頭 `1girl` を `1boy` にすればプレイヤーの性別が変わる
- `flip` … 向きが逆に描かれたものを列挙すると左右反転する(**プレイヤーは右向き・敵は左向き**が正しい)
- `negative` … 他の敵と絵柄が被るときに、その敵だけ追加で禁止したい語を書く
- `background.darken` / `saturation` / `contrast` / `blur` … 背景の暗さ・地味さの調整

## 仕組み上の注意

- **敵とプレイヤーは `isnet-anime` で切り抜く**。人型・生き物には効くが、輪郭を持たない光には効かない。
- **弾は切り抜かない**。黒背景で描かせ、明るさをそのまま不透明度にしている(`luma_cutout`)。
  そのため弾のプロンプトに「暗い」「黒い」と書くと消えてしまう。暗い属性でも
  「bright glowing violet」のように光っている状態で指示すること。
- **背景は必ず暗く・ぼかしてから使う**。そのままだとHPバーやダメージ表示が読めなくなる。
- 切り抜きに失敗すると警告が出る。出たら `--seed` を変えて引き直す。

## ライセンス

Animagine XL 4.0 は **CreativeML Open RAIL++-M**。商用利用は認められているが、
モデルを差し替えるときは、その配布元のライセンスを必ず確認すること。
