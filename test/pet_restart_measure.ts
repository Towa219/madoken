// pet_feature_measure.ts が保存した卵を、サーバー再起動後に再取得して永続性を測る。
const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2808';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
const name = `再起動保持${new URL(基点).port}`;
const 応答 = await fetch(`${基点}/api/pet/list`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 合言葉, name }),
});
const データ = await 応答.json() as { pets?: Array<{ id?: string }> };
const 数 = データ.pets?.length ?? -1;
console.log('【4・後半】サーバー再起動後の永続性測定');
console.log(`実測: 状態=${応答.status}、保存名=${name}、再起動後=${数}羽、識別子=${データ.pets?.[0]?.id ?? 'なし'}`);
console.log(数 === 1 ? '測定結果: ペットは再起動後も残りました。' : 数 === 0 ? '測定結果: ペットは再起動で失われました。' : '測定結果: 想定外の件数です。');
if (応答.status !== 200 || (数 !== 0 && 数 !== 1)) process.exitCode = 1;
