// 本日のTipsを2週間分ながめる(内容確認用)
import { todaysTip } from '../src/tips';

for (let d = 2; d <= 15; d++) {
  const dt = new Date(2026, 7, d);
  console.log(`8/${d}: ${todaysTip(dt)}`);
}
