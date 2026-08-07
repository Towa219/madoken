// 外部リンクの設定(ここを書き換えるだけで画面に反映される)

// 皆に配るURL(共有ボタンで使う) = 入口の待機ページ。
//
// ゲーム本体(https://madoken.onrender.com)を直に配ってはいけない。
// 本体は15分ほど誰も遊ばないと眠り、起こすのに30〜60秒かかる。
// その間は Render の起動画面が出るだけで、初めて来た人は
// 「壊れている」と受け取ってしまう。
//
// 待機ページは GitHub Pages にあり、常に即座に開く(docs/index.html)。
// 開いた瞬間に事情を伝えて、裏で本体を起こし、起きたら自動で送る。
export const SITE_URL = 'https://towa219.github.io/madoken/';

// ゲーム本体。待機ページから送られる先で、直接開いても遊べる。
export const GAME_URL = 'https://madoken.onrender.com';

// 支援ページのURL。空のままなら「支援」欄は表示されない。
// 例: 'https://ko-fi.com/xxxx' / 'https://xxxx.booth.pm/' / 'https://www.pixiv.net/fanbox/creator/xxxx'
export const SUPPORT_URL = 'https://madoken.booth.pm/';
export const SUPPORT_LABEL = 'BOOTHで開発を支援する';
export const SUPPORT_NOTE =
  'いただいた支援は、サーバー代(有料プランにするとスリープが無くなります)と'
  + 'グラフィック・音の制作に使わせていただきます。';
