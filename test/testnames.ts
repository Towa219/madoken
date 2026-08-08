// 検証で使った偽の名前を、終わったら必ず片づける。
//
// ★ なぜ要るか(実際にやらかした)
//   検証はセーブを作ってブラウザに読ませる。ゲームは起動時に
//   魔導値ランキングへ自動で登録する(src/cloudsave.ts)ので、
//   本番(MADOKEN_ENDPOINT=https://…)に向けて走らせると、
//   検証用の偽プレイヤーが本物のランキングに載ってしまう。
//   2026-08-08、お供の倍率を見るために作った「sc強」
//   (レジェンド+9を4本持たせた架空の人)が魔導値5491で1位に居座り、
//   遊んでいる人を押しのけた。
//
//   /api/name/release は名前の予約を外し、同時にランキングの記録も消す。
//   持ち主の合図(nickToken)が要るが、検証は自分で決めているので出せる。

export interface TestName {
  name: string;
  token: string;
}

// 後片づけ。消せなくても検証は止めない(消し忘れを黙らせないため必ず出力する)。
export async function releaseTestNames(
  http: string, names: TestName[],
): Promise<void> {
  for (const n of names) {
    try {
      const r = await fetch(`${http}/api/name/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: n.name, token: n.token }),
      }).then(x => x.json() as Promise<{ released?: boolean }>);
      console.log(`     後片づけ: ${n.name} → ${r?.released ? '消した' : '消せなかった'}`);
    } catch (err) {
      console.log(`     後片づけ: ${n.name} → 失敗 (${(err as Error).message})`);
    }
  }
}
