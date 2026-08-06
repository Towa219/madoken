# キャラクターの絵を、作り直す前(v0.52.0時点・Animagine XL製)に戻す。
#
# 新しい絵が気に入らなかった時に、これ1本で元通りにする。
# 退避してある tools\artgen\art_v1\ から書き戻すので、git の知識は要らない。
#
#   powershell -ExecutionPolicy Bypass -File tools\art_rollback.ps1
#
# 戻した後は必ず npm run build を実行すること(dist に反映される)。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$old  = Join-Path $root 'tools\artgen\art_v1'
$img  = Join-Path $root 'public\img'

if (-not (Test-Path $old)) {
  Write-Output "退避先が見つからない: $old"
  Write-Output '戻せる絵が無い。git から戻すこと(git checkout v0.52.0 -- public/img)。'
  exit 1
}

# 新しく足したポーズ絵を先に消す。
# 消さずに上書きだけすると、旧キャラに新ポーズが混ざった状態になる。
$poses = Get-ChildItem (Join-Path $img 'player'), (Join-Path $img 'enemy') `
  -Filter '*_*.png' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '_(cast|release|hurt)\.png$' }
foreach ($f in $poses) { Remove-Item $f.FullName -Force }
Write-Output "ポーズ絵を削除: $($poses.Count) 枚"

Copy-Item (Join-Path $old 'player') -Destination $img -Recurse -Force
Copy-Item (Join-Path $old 'enemy')  -Destination $img -Recurse -Force
Copy-Item (Join-Path $old 'manifest.json') -Destination $img -Force

$n = (Get-ChildItem (Join-Path $img 'player'), (Join-Path $img 'enemy') -File).Count
Write-Output "元の絵に戻した($n 枚)。"
Write-Output ''
Write-Output '次にこれを実行すること:'
Write-Output '  npm run build'
Write-Output '  git add -A; git commit -m "キャラ画像を元に戻す"; git push'
