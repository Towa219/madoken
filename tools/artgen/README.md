# 画像素材ジェネレータ

ローカルの **ComfyUI + Animagine XL 4.0** で `public/img/` の画像を作り直すための道具。
生成 → 背景透過 → 大きさ調整 → `manifest.json` 更新 までを一括で行う。

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
