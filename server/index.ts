// ゲームサーバー本体: 静的配信(dist) + Colyseus(ロビーチャット/共闘)

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'node:path';
// colyseus系はCJSパッケージのため、Node ESMではデフォルトimport経由で取り出す
import colyseusPkg from 'colyseus';
import wsTransportPkg from '@colyseus/ws-transport';
import { LobbyChatRoom } from './rooms/LobbyChatRoom';
import { CoopRoom } from './rooms/CoopRoom';
import { DuelRoom } from './rooms/DuelRoom';
import { magicRankScore, persistent, removeScore, submitScore, topRanking } from './ranking';
import { banName, bannedNames, unbanName } from './banlist';
import { recentConnections } from './connlog';
import { buildReport, discordEnabled, sendNow, startDiscordReports } from './discord';
import { presenceSnapshot } from './presence';
import { checkName, claimName, forceReleaseName, releaseName } from './names';
import { deleteSave, getSave, putSave } from './save';
import { BUILD_DATE, VERSION } from '../shared/version';
import {
  BREED_EGG_HOURS, DAY_MS, MAX_PETS, canBreed, canWarm, countHeld, breed,
  canChoose, eggSpeciesForBoss, maskPet, pickPetName, warmLeft, wildGene, WARM_INTERVAL_MS,
} from '../shared/pets';
import type { Pet } from '../shared/pets';
import { boardPet, listBoard, listPets, savePets, serializePet, unboardPet } from './pets';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // クラウドセーブのため少し大きめ

// ランキングAPI(上位3件)
app.get('/api/ranking', (_req, res) => {
  void topRanking(3)
    .then(entries => res.json({ persistent, entries }))
    .catch(() => res.json({ persistent, entries: [] }));
});

// ===== 合言葉の総当たり対策 =====
//
// ★ 入口ごとに別々の判定を書いてはいけない。
//   もともと歯止めは /api/admin/check にしか無く、/api/pet/* は
//   素の文字列比較だけだった。check を避けてペットの入口を叩けば、
//   ロックされずに何度でも試せる状態だった(2026-08-11に気づいた)。
//   ADMIN_KEY はランキングの削除や名前の禁止と同じ鍵なので、
//   破られるとペットだけの被害では済まない。
//
// ★ 数えるのは「外れた回数」。当たれば記録を消す。
//   正しく使っている人が締め出されないようにするため。
const adminTries = new Map<string, { n: number; until: number }>();
const ADMIN_MAX_TRIES = 5;
const ADMIN_LOCK_MS = 10 * 60_000;

type KeyVerdict = 'ok' | 'bad' | 'locked' | 'unset';

function verifyAdminKey(req: express.Request, given: string): KeyVerdict {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return 'unset';
  const who = String(req.ip ?? 'unknown');
  const now = Date.now();
  const rec = adminTries.get(who);
  if (rec && rec.until > now) return 'locked';
  if (given !== adminKey) {
    // ★ 「まだ一度もロックされていない(until === 0)」と
    //   「ロックが明けた(until > 0 かつ過去)」を区別すること。
    //   元は `rec.until <= now ? 0 : rec.n` と書いてあったが、
    //   ロックしていない記録は until が 0 なので必ず真になり、
    //   外すたびに回数が 0 へ戻って永久にロックされなかった。
    //   歯止めがある顔をして、実際には無制限に試せていた。
    const 続き = rec && rec.until === 0 ? rec.n : 0;
    const n = 続き + 1;
    adminTries.set(who, { n, until: n >= ADMIN_MAX_TRIES ? now + ADMIN_LOCK_MS : 0 });
    return 'bad';
  }
  adminTries.delete(who);
  return 'ok';
}

// ロック中に返す文言。あと何分待てばよいかまで出す。
function lockedMessage(req: express.Request): string {
  const rec = adminTries.get(String(req.ip ?? 'unknown'));
  const min = rec ? Math.max(1, Math.ceil((rec.until - Date.now()) / 60_000)) : 1;
  return `試行が多すぎます。約${min}分あけてください。`;
}

// ===== ランキングの管理(ADMIN_KEY が要る) =====
//
// 不適切な名前が載った時に、記録を消して名前そのものを塞ぐための入口。
// 消すだけでは同じ名前で登録し直せてしまうので、禁止名の一覧も持つ。
//
//   一覧   GET  /api/admin/ranking?key=KEY
//   削除   POST /api/admin/ranking/remove  {key, name, ban}
//   禁止名 GET  /api/admin/ban?key=KEY
//          POST /api/admin/ban  {key, name, action: 'add' | 'remove'}
function adminOk(req: express.Request, res: express.Response): boolean {
  const given = String(req.query.key ?? (req.body as { key?: unknown })?.key ?? '');
  const v = verifyAdminKey(req, given);
  if (v === 'ok') return true;
  res.status(403).json({
    error: v === 'unset' ? 'ADMIN_KEY が未設定です(Renderの環境変数に足してください)'
      : v === 'locked' ? lockedMessage(req)
      : 'キーが違います',
  });
  return false;
}

type PetBody = { key?: unknown; name?: unknown; petId?: unknown; partnerId?: unknown };

async function petPlayerOk(req: express.Request, res: express.Response): Promise<string | null> {
  const b = req.body as { name?: unknown; token?: unknown };
  const name = String(b?.name ?? '').trim();
  if (!name) { res.status(400).json({ error: 'ニックネームを入力してください。' }); return null; }
  const r = await claimName(name, b?.token);
  if (!r.ok) { res.status(403).json({ error: r.error ?? '本人確認できません。' }); return null; }
  return name;
}

// ペットの入口も同じ判定を通す。ここだけ素の比較にしてはいけない
// (総当たりの抜け道になる。上の verifyAdminKey の注記を参照)。
function petAdminOk(req: express.Request, res: express.Response): boolean {
  const given = String((req.body as { key?: unknown })?.key ?? '');
  const v = verifyAdminKey(req, given);
  if (v === 'ok') return true;
  res.status(403).json({
    error: v === 'locked' ? lockedMessage(req)
      : 'ペット機能には正しい管理者の合言葉が必要です。',
  });
  return false;
}

function petName(body: PetBody, res: express.Response): string | null {
  const name = String(body.name ?? '').trim();
  if (!name) { res.status(400).json({ error: 'ニックネームを入力してください。' }); return null; }
  return name;
}

function newEgg(ownerName: string, species: Pet['species'], now: number): Pet {
  return {
    id: crypto.randomUUID(), ownerName, species, name: '', sex: Math.random() < 0.5 ? 'm' : 'f',
    hpGene: wildGene(), mpGene: wildGene(), lifeGene: wildGene(), warmCount: 0,
    lastWarmAt: now, hatchedAt: 0, boarded: false, chosen: false,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: now,
  };
}

// ★ 端末へ返すペットは必ず maskPet を通す。
//   卵のうちは species を落として「何が生まれるか」を伏せるため。
//   画面側で隠すだけだと、開発者ツールで JSON を覗けば読めてしまう。
const wire = (pets: Pet[]) => pets.map(maskPet);

app.post('/api/pet/list', (req, res) => {
  void (async () => {
    const name = await petPlayerOk(req, res); if (!name) return;
    const includeBoard = (req.body as { board?: unknown }).board !== false;
    const [pets, board] = await Promise.all([listPets(name), includeBoard ? listBoard() : Promise.resolve([])]);
    res.json({ ok: true, pets: wire(pets), board: wire(board), now: Date.now() });
  })()
    .catch(() => res.status(500).json({ error: 'ペット一覧を読み込めませんでした。' }));
});

app.post('/api/pet/grant', (req, res) => {
  if (!petAdminOk(req, res)) return;
  const body = req.body as PetBody & { stage?: unknown };
  const name = petName(body, res); if (!name) return;
  void serializePet(name, async () => {
    const pets = await listPets(name);
    const now = Date.now();
    if (countHeld(pets, now) >= MAX_PETS) { res.status(400).json({ error: '手持ちのペットが上限です。' }); return; }
    const pet = newEgg(name, eggSpeciesForBoss(Number(body.stage) || 0), now);
    pets.push(pet); await savePets(name, pets); res.json({ ok: true, pet: maskPet(pet) });
  }).catch(() => res.status(500).json({ error: '卵を追加できませんでした。' }));
});

app.post('/api/pet/warm', (req, res) => {
  void (async () => {
    const body = req.body as PetBody; const name = await petPlayerOk(req, res); if (!name) return;
    await serializePet(name, async () => {
      const pets = await listPets(name); const pet = pets.find(p => p.id === String(body.petId ?? ''));
      if (!pet || pet.boarded) { res.status(404).json({ error: '温める卵が見つかりません。' }); return; }
      const now = Date.now();
      if (!canWarm(pet, now)) { res.status(400).json({ error: 'まだ温められる時間ではありません。' }); return; }
      pet.warmCount += 1; pet.lastWarmAt = now;
      const hatched = warmLeft(pet) === 0;
      if (hatched) {
        pet.hatchedAt = now;
        pet.name = pickPetName(pets.filter(p => p !== pet).map(p => p.name));
      }
      await savePets(name, pets);
      res.json({ ok: true, pet: maskPet(pet), hatched });
    });
  })().catch(() => res.status(500).json({ error: '卵を温められませんでした。' }));
});

// 名前は生まれた時にサーバーが決める。付け替えはできない。
//
// ★ 経路ごと消してはいけない。消すと静的配信の受け皿に落ちて index.html が
//   200 で返り、古い画面からは「成功した」ように見えてしまう。
app.post('/api/pet/rename', (req, res) => {
  if (!petAdminOk(req, res)) return;
  res.status(400).json({ error: '名前は生まれた時に決まります。付け替えはできません。' });
});

app.post('/api/pet/choose', (req, res) => {
  void (async () => {
    const body = req.body as PetBody; const name = await petPlayerOk(req, res); if (!name) return;
    await serializePet(name, async () => {
      const pets = await listPets(name); const petId = String(body.petId ?? '');
      if (petId === '') {
        for (const pet of pets) pet.chosen = false;
        await savePets(name, pets); res.json({ ok: true }); return;
      }
      const pet = pets.find(p => p.id === petId);
      if (!pet) { res.status(404).json({ error: 'ペットが見つかりません。' }); return; }
      const reason = canChoose(pet, Date.now());
      if (reason) { res.status(400).json({ error: reason }); return; }
      for (const item of pets) item.chosen = item.id === petId;
      await savePets(name, pets); res.json({ ok: true, pet: maskPet(pet) });
    });
  })().catch(() => res.status(500).json({ error: '連れて行くペットを変更できませんでした。' }));
});

app.post('/api/pet/release', (req, res) => {
  void (async () => {
    const body = req.body as PetBody; const name = await petPlayerOk(req, res); if (!name) return;
    await serializePet(name, async () => {
      const pets = await listPets(name); const pet = pets.find(p => p.id === String(body.petId ?? ''));
      if (!pet) { res.status(404).json({ error: 'ペットが見つかりません。' }); return; }
      pet.chosen = false;
      if (pet.boarded) await unboardPet(name, pet.id);
      await savePets(name, (await listPets(name)).filter(p => p.id !== pet.id)); res.json({ ok: true });
    });
  })().catch(() => res.status(500).json({ error: 'ペットを手放せませんでした。' }));
});

for (const [pathName, action] of [
  ['/api/pet/board', boardPet], ['/api/pet/unboard', unboardPet],
] as const) {
  app.post(pathName, (req, res) => {
    void (async () => {
      const body = req.body as PetBody; const name = await petPlayerOk(req, res); if (!name) return;
      const ok = await serializePet(name, () => action(name, String(body.petId ?? '')));
      if (!ok) res.status(400).json({ error: 'ペットの預け入れ状態を変更できません。' });
      else res.json({ ok: true });
    })().catch(() => res.status(500).json({ error: '交配所を更新できませんでした。' }));
  });
}

app.post('/api/pet/breed', (req, res) => {
  void (async () => {
    const body = req.body as PetBody; const name = await petPlayerOk(req, res); if (!name) return;
    const partnerId = String(body.partnerId ?? '');
    // 二人分のロック名を決めるための事前確認。ロック取得後に必ず読み直す。
    const previewPets = await listPets(name);
    const previewPartner = previewPets.find(p => p.id === partnerId)
      ?? (await listBoard()).find(p => p.id === partnerId);
    if (!previewPartner) { res.status(404).json({ error: '親にするペットが見つかりません。' }); return; }

    await serializePet([name, previewPartner.ownerName], async () => {
      const pets = await listPets(name); const now = Date.now();
      if (countHeld(pets, now) >= MAX_PETS) { res.status(400).json({ error: '手持ちのペットが上限です。' }); return; }
      const mine = pets.find(p => p.id === String(body.petId ?? '') && !p.boarded);
      // 自分の手持ちを優先し、そこにいない時だけ交配所を探す。
      const partner = pets.find(p => p.id === partnerId)
        ?? (await listBoard()).find(p => p.id === partnerId);
      if (!mine || !partner || partner.ownerName !== previewPartner.ownerName) {
        res.status(404).json({ error: '親にするペットが見つかりません。' }); return;
      }
      const sameOwner = partner.ownerName === name;
      const ownerPets = sameOwner ? pets : await listPets(partner.ownerName);
      if (!sameOwner && countHeld(ownerPets, now) >= MAX_PETS) {
        res.status(400).json({ error: '預けた側がお礼の卵を受け取れる上限を超えています。' }); return;
      }
      const reason = canBreed(mine, partner, now);
      if (reason) { res.status(400).json({ error: reason }); return; }
      const partnerOwned = ownerPets.find(p => p.id === partner.id);
      if (!partnerOwned) { res.status(404).json({ error: '相手のペットが見つかりません。' }); return; }
      mine.breedCount += 1; mine.lastBredAt = now;
      partnerOwned.breedCount += 1; partnerOwned.lastBredAt = now;

      const readyAt = now + BREED_EGG_HOURS * 60 * 60 * 1000;
      const 温め開始 = readyAt - WARM_INTERVAL_MS;
      const result = breed(mine, partner);
      const child: Pet = {
        ...newEgg(name, result.species, now), ...result,
        lastWarmAt: 温め開始, parents: [mine.id, partner.id],
      };
      pets.push(child);
      if (!sameOwner) {
        const thanksResult = breed(partner, mine);
        ownerPets.push({
          ...newEgg(partner.ownerName, thanksResult.species, now), ...thanksResult,
          lastWarmAt: 温め開始, parents: [partner.id, mine.id],
        });
      }
      await savePets(name, pets);
      if (!sameOwner) await savePets(partner.ownerName, ownerPets);
      // 預けられている相手だけ、交配所の写しにも新しい履歴を反映する。
      if (partnerOwned.boarded) {
        await unboardPet(partner.ownerName, partner.id);
        await boardPet(partner.ownerName, partner.id);
      }
      res.json({ ok: true, pet: maskPet(child), readyAt });
    });
  })().catch(() => res.status(500).json({ error: '交配できませんでした。' }));
});

app.post('/api/pet/advance', (req, res) => {
  if (!petAdminOk(req, res)) return;
  const body = req.body as PetBody & { days?: unknown }; const name = petName(body, res); if (!name) return;
  const days = Number(body.days);
  if (!Number.isFinite(days) || days < 0 || days > 3650) { res.status(400).json({ error: '進める日数は0日以上3650日以下にしてください。' }); return; }
  void serializePet(name, async () => {
    const pets = await listPets(name); const shift = days * DAY_MS;
    // ★ 時刻を持つ欄はすべて動かすこと。1つでも取りこぼすと、
    //   そこだけ時間が止まる。lastBredAt を忘れていて、日を進めても
    //   交配の待ち時間が永久に明けなくなっていた(実測で判明)。
    for (const pet of pets) {
      pet.bornAt -= shift; pet.lastWarmAt -= shift;
      if (pet.hatchedAt > 0) pet.hatchedAt -= shift;
      if (pet.lastBredAt > 0) pet.lastBredAt -= shift;
    }
    await savePets(name, pets);
    for (const pet of pets.filter(p => p.boarded)) { await unboardPet(name, pet.id); await boardPet(name, pet.id); }
    res.json({ ok: true, pets: wire(pets) });
  }).catch(() => res.status(500).json({ error: '時刻を進められませんでした。' }));
});

app.get('/api/admin/ranking', (req, res) => {
  if (!adminOk(req, res)) return;
  const n = Math.max(1, Math.min(200, Math.floor(Number(req.query.n) || 100)));
  void topRanking(n)
    .then(entries => res.json({ persistent, count: entries.length, entries }))
    .catch(() => res.json({ persistent, count: 0, entries: [] }));
});

app.post('/api/admin/ranking/remove', (req, res) => {
  if (!adminOk(req, res)) return;
  const body = req.body as { name?: unknown; ban?: unknown };
  const name = String(body?.name ?? '');
  if (!name) { res.status(400).json({ error: '名前が空です' }); return; }
  void (async () => {
    await removeScore(name);
    // 名前を塞ぐ場合は、持ち主の予約も外す。
    // 外さないと、その人の端末からは同じ名前で入り続けられる。
    let banned = '';
    if (body?.ban) {
      banned = await banName(name);
      await forceReleaseName(name);
    }
    res.json({ ok: true, removed: name, banned: banned || null });
  })().catch(() => res.status(500).json({ error: '削除に失敗しました' }));
});

app.get('/api/admin/ban', (req, res) => {
  if (!adminOk(req, res)) return;
  void bannedNames()
    .then(names => res.json({ count: names.length, names }))
    .catch(() => res.json({ count: 0, names: [] }));
});

app.post('/api/admin/ban', (req, res) => {
  if (!adminOk(req, res)) return;
  const body = req.body as { name?: unknown; action?: unknown };
  const name = String(body?.name ?? '');
  const action = String(body?.action ?? 'add');
  if (!name) { res.status(400).json({ error: '名前が空です' }); return; }
  void (async () => {
    if (action === 'remove') {
      res.json({ ok: true, unbanned: await unbanName(name) });
      return;
    }
    const banned = await banName(name);
    await removeScore(name);
    await forceReleaseName(name);
    res.json({ ok: true, banned });
  })().catch(() => res.status(500).json({ error: '操作に失敗しました' }));
});

// 管理者モードの合言葉を確かめる。
//
// ★ なぜサーバーで確かめるのか
//   このリポジトリは公開なので、クライアント側に書いた判定はソースを読めば
//   誰でも突破できる。管理者モードで触れるもの(ペットなど)は戦闘の強さや
//   他人との交配に関わるため、判定はサーバーに置く。
//   鍵は Render の環境変数にだけあり、リポジトリには入っていない。
//
// ★ 総当たりを防ぐ。
//   合言葉は短いので、放っておくと片端から試される。
//   同じ相手からの失敗が続いたら、しばらく受け付けない。
app.post('/api/admin/check', (req, res) => {
  const v = verifyAdminKey(req, String((req.body as { key?: unknown })?.key ?? ''));
  if (v === 'ok') { res.json({ ok: true }); return; }
  res.json({
    ok: false,
    error: v === 'unset' ? 'ADMIN_KEY が未設定です(Renderの環境変数に足してください)'
      : v === 'locked' ? lockedMessage(req)
      : '合言葉が違います。',
  });
});

app.get('/api/connlog', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(403).json({
      error: 'ADMIN_KEY未設定のため無効。Renderのログ画面で「[接続]」の行を確認してください。',
    });
    return;
  }
  if (String(req.query.key ?? '') !== adminKey) {
    res.status(403).json({ error: 'キーが違います' });
    return;
  }
  const n = Math.max(1, Math.min(200, Math.floor(Number(req.query.n) || 50)));
  void recentConnections(n)
    .then(entries => res.json({ entries }))
    .catch(() => res.json({ entries: [] }));
});

// 魔導値ランキングへの登録。
//
// スコアはサーバーで計算し直す。クライアントが送ってくるのはレシピ・強化Lv・品質
// だけで、魔導値の申告は受け取らない。受け取ると、いくらでも詐称できてしまう。
app.post('/api/ranking/submit', (req, res) => {
  const body = req.body as {
    name?: unknown; nickToken?: unknown; spells?: unknown; bossCleared?: unknown;
    charId?: unknown;
  };
  void (async () => {
    // 名前の持ち主であることを確認する(他人の名前で登録させない)
    const r = await claimName(body?.name, body?.nickToken);
    if (!r.ok) {
      res.status(403).json({ ok: false, error: r.error ?? '名前を確認できません' });
      return;
    }
    const score = magicRankScore(body?.spells, body?.bossCleared, body?.charId);
    submitScore(String(body?.name ?? ''), score.total, score.names);
    res.json({ ok: true, score: score.total });
  })().catch(() => res.status(500).json({ ok: false, error: '登録に失敗しました' }));
});

// ===== ニックネーム登録簿(重複防止) =====

// 入力欄の事前チェック(登録はしない)
app.get('/api/name/check', (req, res) => {
  void checkName(req.query.name, req.query.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: true }));
});

// 名前を確保する(初回接続時)
app.post('/api/name/claim', (req, res) => {
  const body = req.body as { name?: unknown; token?: unknown };
  void claimName(body?.name, body?.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: true }));
});

// 名前を手放す(キャラ初期化時)。所有者本人のときだけ消える。
// 同時にランキングの記録も消す(次にその名前を取った人の記録と混ざらないように)。
app.post('/api/name/release', (req, res) => {
  const body = req.body as { name?: unknown; token?: unknown };
  void releaseName(body?.name, body?.token)
    .then(async released => {
      if (released) await removeScore(String(body?.name ?? ''));
      res.json({ released });
    })
    .catch(() => res.json({ released: false }));
});

// ===== サーバー側セーブ(クラウドセーブ) =====

// 保存(ニックネーム+引き継ぎコードが本人のものであること)
app.post('/api/save', (req, res) => {
  const b = req.body as {
    name?: unknown; token?: unknown; data?: unknown; savedAt?: unknown; force?: unknown;
  };
  void putSave(b?.name, b?.token, b?.data, Number(b?.savedAt) || Date.now(), b?.force === true)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: false, error: '保存に失敗しました。' }));
});

// 読み込み(別の端末への引き継ぎもこれ)
app.post('/api/load', (req, res) => {
  const b = req.body as { name?: unknown; token?: unknown };
  void getSave(b?.name, b?.token)
    .then(r => res.json(r))
    .catch(() => res.json({ ok: false, error: '読み込みに失敗しました。' }));
});

// 削除(キャラ初期化時)
app.post('/api/save/delete', (req, res) => {
  const b = req.body as { name?: unknown; token?: unknown };
  void deleteSave(b?.name, b?.token)
    .then(deleted => res.json({ deleted }))
    .catch(() => res.json({ deleted: false }));
});

// プレイ中人数: クライアントが定期的に叩く簡易ハートビート
// (ロビー未接続でもページを開いていればカウントされる)
const heartbeats = new Map<string, number>();
const ALIVE_MS = 90_000;

function onlineCount(): number {
  const now = Date.now();
  for (const [k, t] of heartbeats) {
    if (now - t > ALIVE_MS) heartbeats.delete(k);
  }
  return heartbeats.size;
}

app.get('/api/heartbeat', (req, res) => {
  const id = String(req.query.id ?? '').slice(0, 40);
  if (id) heartbeats.set(id, Date.now());
  res.json({ count: onlineCount() });
});

// 動いている版と連続稼働時間を返すだけの入口。
//
// ★ 以前は「外部のcronから定期的に叩いて眠らせない」ための的だったが、
//   2026-08-09にRenderから警告のメールが来たのでその運用はやめた。
//   無料枠(月750時間)の計算が合っていても、外から起こし続ける使い方
//   そのものが想定から外れている。眠るのは受け入れて、待つ人が驚かない
//   ようにする方(docs/ の待機ページ)に寄せた。
//
// 残してあるのは手元からの確認用。リリースのたびに
//   curl https://madoken.onrender.com/api/ping
// で「本番がどの版か」「起きているか」を見ている。
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), version: VERSION });
});

// サーバーの稼働状態(秘密情報は含めない・動作確認用)
app.get('/api/status', (_req, res) => {
  res.json({
    version: VERSION,
    build: BUILD_DATE,
    rankingPersistent: persistent,
    discordEnabled,
    online: onlineCount(),
    rooms: presenceSnapshot().map(r => ({
      type: r.type, label: r.label, count: r.names.length,
    })),
  });
});

// Discordへ今すぐ1回送る(ADMIN_KEY必須・動作確認用)
app.get('/api/discord-test', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || String(req.query.key ?? '') !== adminKey) {
    res.status(403).json({ error: 'ADMIN_KEYが必要です' });
    return;
  }
  // 送るだけでなく本文も返す。Webhook未設定の環境でも中身を確かめられる。
  void Promise.all([sendNow(onlineCount()), buildReport(onlineCount())])
    .then(([sent, text]) => res.json({ sent, enabled: discordEnabled, text }))
    .catch(() => res.json({ sent: false, enabled: discordEnabled }));
});

// ビルド済みクライアントを配信
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

const httpServer = createServer(app);

const gameServer = new Server({
  // 既定値は ping 3秒 × 2回 = 約6秒の無応答で切断。これは厳しすぎる。
  // スマホの画面を消した、電波が一瞬途切れた、PCがスリープしかけた程度で
  // 戦闘中に切られてしまう。25秒まで待つようにした。
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 5000,
    pingMaxRetries: 5,
  }),
});

gameServer.define('lobby_chat', LobbyChatRoom);
gameServer.define('coop', CoopRoom);
gameServer.define('duel', DuelRoom);

httpServer.listen(port, () => {
  console.log(`[魔導研究記サーバー] ポート${port}で待機中 (http://localhost:${port})`);
  console.log(
    persistent
      ? '[ランキング] Upstashに恒久保存します'
      : '[ランキング] 一時保存(再起動でリセット)。UPSTASH_REDIS_REST_URL/TOKEN未設定',
  );
  startDiscordReports(onlineCount);
});
