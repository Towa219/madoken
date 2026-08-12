// ペットのMP自然回復の単体検証。ブラウザやサーバーなしで実行できる。
//
//   npx tsx test/pet_regen_check.ts
import { PLAYER_MP_REGEN } from '../shared/data';
import {
  DAY_MS, ELDER_DAYS, PET_SPECIES, PET_SPECIES_ORDER, REGEN_MP_THRESHOLD,
  bonusOf, partyBonusOf, regenOf,
} from '../shared/pets';
import type { Pet, PetSpeciesId } from '../shared/pets';

let 失敗数 = 0;

function 確認(条件: boolean, 文: string): void {
  if (条件) console.log(`OK ${文}`);
  else { console.error(`NG ${文}`); 失敗数 += 1; }
}

function 個体(species: PetSpeciesId, hatchedAt: number, hpGene = 50, mpGene = 50): Pet {
  return {
    id: '検証鳥', ownerName: '検証者', species, name: '', sex: 'm',
    hpGene, mpGene, lifeGene: 50, warmCount: PET_SPECIES[species].warmNeeded,
    lastWarmAt: 0, hatchedAt, boarded: false, boardedAt: 0, eggAt: 0, chosen: true,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: 0,
  };
}

const 今 = 1000 * DAY_MS;
const 高回復 = PET_SPECIES_ORDER.filter(id => PET_SPECIES[id].mp >= REGEN_MP_THRESHOLD);
確認(高回復.length === 3 && 高回復.includes('owl') && 高回復.includes('swallow')
  && 高回復.includes('bluebird'), 'MP12以上の種類はフクロウ・ツバメ・アオイトリの3種だけ');

for (const id of PET_SPECIES_ORDER) {
  const 回復 = regenOf(id);
  const 期待 = PET_SPECIES[id].mp >= REGEN_MP_THRESHOLD ? 2 : 1;
  確認((回復 === 1 || 回復 === 2) && 回復 === 期待,
    `${PET_SPECIES[id].name}の成鳥時MP回復は+${期待}`);
}

for (const id of PET_SPECIES_ORDER) {
  const sp = PET_SPECIES[id];
  const 雛 = 個体(id, 今 - DAY_MS);
  const 成鳥 = 個体(id, 今 - (sp.chickDays + 1) * DAY_MS);
  const 老鳥 = 個体(id, 今 - (sp.chickDays + sp.lifeDays + 1) * DAY_MS);
  const 卵 = 個体(id, 0);
  const 死 = 個体(id, 今 - (sp.chickDays + sp.lifeDays + ELDER_DAYS + 1) * DAY_MS);
  確認(bonusOf(成鳥, 今).regen === regenOf(id), `${sp.name}の成鳥は種類どおりのMP回復`);
  確認(bonusOf(雛, 今).regen === 1 && bonusOf(老鳥, 今).regen === 1,
    `${sp.name}の雛と老鳥はMP回復+1`);
  確認(bonusOf(卵, 今).regen === 0 && bonusOf(死, 今).regen === 0,
    `${sp.name}の卵と死後はMP回復+0`);
  const 低個体値 = bonusOf(個体(id, 成鳥.hatchedAt, 0, 0), 今).regen;
  const 高個体値 = bonusOf(個体(id, 成鳥.hatchedAt, 100, 100), 今).regen;
  確認(低個体値 === 高個体値 && 高個体値 === regenOf(id),
    `${sp.name}のMP回復はHP・MP個体値で変わらない`);
}

確認(partyBonusOf([], 今).regen === 0, '誰も連れていない時のパーティーMP回復は+0');

for (const 回復 of [1, 2]) {
  const 追加MP = 回復 * 90;
  const 割合 = 回復 / PLAYER_MP_REGEN * 100;
  console.log(`参考 90秒の戦闘では毎秒+${回復}の鳥がMPを${追加MP}追加回復し、基礎自然回復の${割合.toFixed(1)}%ぶんです`);
}

if (失敗数 === 0) console.log('OK すべて合格しました');
else {
  console.error(`NG ${失敗数}件失敗しました`);
  process.exit(1);
}
