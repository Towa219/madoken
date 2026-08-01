// ロビーへのお知らせ配信
//
// 共闘部屋や決闘場は別のRoomなので、ロビーへ直接は喋れない。
// ここに登録された送り口(ロビー)へ、募集情報などを流す。

type Sink = (text: string) => void;

const sinks = new Set<Sink>();

// 直前に流した内容と時刻(同じ知らせの連投を防ぐ)
const lastSent = new Map<string, number>();
const DEDUPE_MS = 20_000;

export function addLobbySink(fn: Sink): () => void {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

export function announce(text: string): void {
  const now = Date.now();
  const prev = lastSent.get(text);
  if (prev && now - prev < DEDUPE_MS) return; // 連投は無視
  lastSent.set(text, now);
  // 古い記録を掃除
  for (const [k, t] of lastSent) {
    if (now - t > DEDUPE_MS * 5) lastSent.delete(k);
  }
  for (const sink of sinks) {
    try {
      sink(text);
    } catch { /* 1つ失敗しても他へは流す */ }
  }
}
