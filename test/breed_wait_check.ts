// 交配のなじみ待ちと巣の待ち時間の単体検証。ブラウザやサーバーなしで実行できる。
//
//   npx tsx test/breed_wait_check.ts
import {
  BOARD_SETTLE_MS, BREED_EGG_MS, DAY_MS, PET_SPECIES, WARM_INTERVAL_MS,
  canBreed, canChoose, canWarm, isNest, maskPet,
} from '../shared/pets';
import type { Pet } from '../shared/pets';

let 失敗数 = 0;

function 確認(条件: boolean, 文: string): void {
  if (条件) console.log(`OK ${文}`);
  else { console.error(`NG ${文}`); 失敗数 += 1; }
}

const 今 = 100 * DAY_MS;

function 親(id: string, sex: Pet['sex']): Pet {
  return {
    id, ownerName: '検証者', species: 'sparrow', name: id, sex,
    hpGene: 50, mpGene: 50, lifeGene: 50,
    warmCount: PET_SPECIES.sparrow.warmNeeded, lastWarmAt: 0,
    hatchedAt: 今 - (PET_SPECIES.sparrow.chickDays + 1) * DAY_MS,
    boarded: true, boardedAt: 今, eggAt: 0, chosen: false,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: 0,
  };
}

const 父 = 親('父', 'm');
const 母 = 親('母', 'f');
確認(canBreed(父, 母, 今)?.includes('交配所に慣れていない') === true,
  '預けた直後は交配を断る');
確認(canBreed(父, 母, 今 + BOARD_SETTLE_MS) === null,
  'なじみ時間が過ぎると交配できる');

const 古い父 = { ...父 } as Pet & { boardedAt?: number };
const 古い母 = { ...母 } as Pet & { boardedAt?: number };
delete 古い父.boardedAt;
delete 古い母.boardedAt;
確認(canBreed(古い父, 古い母, 今) === null,
  'boardedAtが無い古い記録は待たされない');

const 子: Pet = {
  id: '子', ownerName: '検証者', species: 'sparrow', name: '', sex: 'f',
  hpGene: 50, mpGene: 50, lifeGene: 50, warmCount: 0,
  lastWarmAt: 今 + BREED_EGG_MS - WARM_INTERVAL_MS,
  hatchedAt: 0, boarded: false, boardedAt: 0, eggAt: 今 + BREED_EGG_MS,
  chosen: false, breedCount: 0, lastBredAt: 0, parents: ['父', '母'], bornAt: 今,
};
確認(isNest(子, 今), '交配直後の子は巣になっている');
確認(!canWarm(子, 今), '巣のあいだは温められない');
確認(!isNest(子, 今 + BREED_EGG_MS), '12時間後に巣から卵になる');
確認(canWarm(子, 今 + BREED_EGG_MS), '卵になった瞬間から温められる');

const ボス卵 = { ...子, eggAt: 0, lastWarmAt: 今 - WARM_INTERVAL_MS };
確認(!isNest(ボス卵, 今), 'eggAtが0のボス卵は最初から卵');
const 古い卵 = { ...ボス卵 } as Pet & { eggAt?: number };
delete 古い卵.eggAt;
確認(!isNest(古い卵, 今), 'eggAtが無い古い卵は最初から卵');

確認(maskPet(子, 今).hint === undefined, '巣のあいだは殻の手がかりを付けない');
確認(maskPet(子, 今 + BREED_EGG_MS).hint !== undefined, '卵になると殻の手がかりを付ける');
確認(canChoose(子, 今)?.includes('まだ巣') === true, '巣は「まだ巣」と断る');

if (失敗数 === 0) console.log('=== 合格 ===');
else {
  console.error(`=== ${失敗数}件 失敗 ===`);
  process.exit(1);
}
