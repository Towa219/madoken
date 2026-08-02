// 「1人が同時に入れる戦闘部屋は1つだけ」を保証する登録簿。
//
// 部屋は client.create('coop') で毎回新しく作られる。前の部屋に自分の接続が
// 残っていると、その部屋が生き続けて一覧に並び続ける(同じ人の部屋がいくつも
// できてしまう)。通信が切れてもサーバーが気づくまでには間があるため、
// 本人が入り直しただけでも起きる。
//
// そこで、新しい戦闘部屋に入った時点で、同じニックネームの古い接続を閉じる。
// 空になった部屋は Colyseus が自動で破棄するので、一覧からも消える。
//
// ロビーは戦闘部屋と同時に繋いだままにするのが正常なので、ここでは扱わない
// (ロビー内の重複は LobbyChatRoom 側で処理している)。

import { nicknameKey } from '../shared/nickname';

interface Entry {
  sessionId: string;
  close: () => void;
}

const active = new Map<string, Entry>();

// 戦闘部屋に入るときに呼ぶ。同じ名前の古い接続があれば閉じる。
export function claimBattleSlot(
  rawName: unknown, sessionId: string, close: () => void,
): void {
  const key = nicknameKey(String(rawName ?? ''));
  if (!key) return;
  const prev = active.get(key);
  if (prev && prev.sessionId !== sessionId) {
    try {
      prev.close();
    } catch { /* 既に閉じている */ }
  }
  active.set(key, { sessionId, close });
}

// 戦闘部屋を出るときに呼ぶ。
// 自分より新しい接続が登録済みなら消さない(入り直しの順番が前後しても壊れない)。
export function releaseBattleSlot(rawName: unknown, sessionId: string): void {
  const key = nicknameKey(String(rawName ?? ''));
  if (!key) return;
  if (active.get(key)?.sessionId === sessionId) active.delete(key);
}
