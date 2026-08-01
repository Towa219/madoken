// ニックネームの規則(クライアントとサーバーの両方で同じ判定を使う)

// 全角を2、半角を1として数えた上限。全角10文字 / 半角20文字まで。
export const NICK_MAX_WIDTH = 20;
export const NICK_MAX_FULL = NICK_MAX_WIDTH / 2; // 全角での目安(10文字)

// 前後の空白は取り除いてから判定する(内側の空白は使用不可)
export function normalizeNickname(raw: unknown): string {
  return String(raw ?? '').trim();
}

// 表示上の幅(全角=2・半角=1)
export function nickWidth(name: string): number {
  let w = 0;
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    // ASCII と半角カタカナは1、それ以外(全角)は2
    const half = (c >= 0x20 && c <= 0x7e) || (c >= 0xff61 && c <= 0xff9f);
    w += half ? 1 : 2;
  }
  return w;
}

// 重複判定用のキー(英字の大小と全角/半角の違いは同じ名前とみなす)
export function nicknameKey(name: string): string {
  return normalizeNickname(name)
    .normalize('NFKC')
    .toLowerCase();
}

// HTMLで意味を持つ記号(表示が崩れる・なりすましに使える)
// 使ってよい文字だけを並べた許可リスト。
// ひらがな / カタカナ(半角も) / 漢字 / 英数字(全角も)のみ。
// 記号(半角・全角とも)・絵文字・制御文字はすべて不可。
const ALLOWED = new RegExp(
  '^['
  + '0-9A-Za-z'                        // 半角英数字
  + '\\uFF10-\\uFF19'                  // 全角数字
  + '\\uFF21-\\uFF3A\\uFF41-\\uFF5A'   // 全角英字
  + '\\u3041-\\u3096'                  // ひらがな
  + '\\u30A1-\\u30FA\\u30FC'           // カタカナ + 長音符
  + '\\uFF66-\\uFF9D'                  // 半角カタカナ
  + '\\u3005'                          // 々(繰り返し記号だが名前で使う)
  + '\\u3400-\\u4DBF\\u4E00-\\u9FFF'   // 漢字
  + ']+$',
);

// 半角スペース・全角スペース・タブなどの空白
const SPACES = /[\s　]/;

// 使えない場合はエラー文言、問題なければ null を返す
export function validateNickname(raw: unknown): string | null {
  const name = normalizeNickname(raw);
  if (!name) return 'ニックネームを入力してください。';
  if (nickWidth(name) > NICK_MAX_WIDTH) {
    return `ニックネームは全角${NICK_MAX_FULL}文字(半角${NICK_MAX_WIDTH}文字)までです。`;
  }
  if (SPACES.test(name)) return 'ニックネームにスペース(半角・全角)は使えません。';
  if (!ALLOWED.test(name)) {
    return 'ニックネームに使えるのは、ひらがな・カタカナ・漢字・英数字だけです'
      + '(記号は半角・全角とも使用不可)。';
  }
  return null;
}

// 表示・保存時の切り詰め(幅で判断する)
export function clampNickname(raw: unknown): string {
  const name = normalizeNickname(raw);
  if (nickWidth(name) <= NICK_MAX_WIDTH) return name;
  let out = '';
  for (const ch of name) {
    if (nickWidth(out + ch) > NICK_MAX_WIDTH) break;
    out += ch;
  }
  return out;
}
