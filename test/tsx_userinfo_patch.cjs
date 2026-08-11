// Windows環境でuv_os_get_passwdが誤って失敗する場合だけ、tsx用の利用者名取得を補う。
const os = require('node:os');
const 元の取得 = os.userInfo;
os.userInfo = function 利用者情報(...引数) {
  try { return 元の取得.apply(this, 引数); }
  catch { return { uid: -1, gid: -1, username: process.env.USERNAME || '検証者', homedir: process.env.USERPROFILE || '', shell: null }; }
};
