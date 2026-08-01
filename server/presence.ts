// 在室状況の集約(Discord通知・診断用)
// 各ルームが自分の在室者を登録し、ここから一覧を取り出す。

interface RoomPresence {
  type: string;   // ロビー / 共闘 / 決闘
  label: string;  // 「ステージ3」など補足
  names: string[];
}

const rooms = new Map<string, RoomPresence>();

export function setRoomPresence(
  roomId: string, type: string, label: string, names: string[],
): void {
  if (names.length === 0) rooms.delete(roomId);
  else rooms.set(roomId, { type, label, names });
}

export function clearRoomPresence(roomId: string): void {
  rooms.delete(roomId);
}

export function presenceSnapshot(): RoomPresence[] {
  return [...rooms.values()];
}

// 重複を除いた実プレイヤー名(ロビーと部屋の両方にいる人は1回だけ)
export function uniqueNames(): string[] {
  const set = new Set<string>();
  for (const r of rooms.values()) for (const n of r.names) set.add(n);
  return [...set];
}
