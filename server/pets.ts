// 試験中のペット保管。Upstash未設定時はサーバー内メモリへ退避する。
import { canTakeEgg, eggSpeciesForBoss, shouldPurge, wildGene } from '../shared/pets';
import type { Pet } from '../shared/pets';
import crypto from 'node:crypto';
import { nicknameKey, normalizeNickname } from '../shared/nickname';
import { persistent, redis } from './upstash';

const PETS_KEY = 'madoken:pets';
const BOARD_KEY = 'madoken:pets:board';
const EGG_STAGES_KEY = 'madoken:pets:eggstages';
const petMemory = new Map<string, string>();
const boardMemory = new Map<string, string>();
const eggStagesMemory = new Map<string, string>();
const petQueues = new Map<string, Promise<void>>();

// 同じ持ち主への「読んでから書く」を一列に並べる。
// 複数人を取る時は必ず同じ順序にし、交差する交配でも待ち合わせを循環させない。
export function serializePet<T>(names: string | string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set((Array.isArray(names) ? names : [names])
    .map(name => nicknameKey(normalizeNickname(name))))].sort();
  const acquire = (index: number): Promise<T> => {
    if (index >= keys.length) return task();
    const key = keys[index];
    const previous = petQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => acquire(index + 1));
    petQueues.set(key, current.then(() => undefined, () => undefined));
    return current.finally(() => {
      const queued = petQueues.get(key);
      void queued?.finally(() => { if (petQueues.get(key) === queued) petQueues.delete(key); });
    });
  };
  return acquire(0);
}

async function readArray(key: string, field: string, memory: Map<string, string>): Promise<Pet[]> {
  const raw = persistent
    ? await redis(['HGET', key, field]).catch(() => null)
    : memory.get(field) ?? null;
  if (raw === null || raw === undefined) return [];
  try {
    const value = JSON.parse(String(raw));
    return Array.isArray(value) ? value as Pet[] : [];
  } catch {
    return [];
  }
}

async function writeArray(
  key: string, field: string, value: Pet[], memory: Map<string, string>,
): Promise<void> {
  const body = JSON.stringify(value);
  if (!persistent) {
    if (value.length) memory.set(field, body);
    else memory.delete(field);
    return;
  }
  if (value.length) await redis(['HSET', key, field, body]);
  else await redis(['HDEL', key, field]);
}

export async function listPets(name: string): Promise<Pet[]> {
  const now = Date.now();
  return (await readArray(PETS_KEY, nicknameKey(normalizeNickname(name)), petMemory))
    .filter(pet => !shouldPurge(pet, now));
}

export async function savePets(name: string, pets: Pet[]): Promise<void> {
  await writeArray(PETS_KEY, nicknameKey(normalizeNickname(name)), pets, petMemory);
}

export async function listBoard(): Promise<Pet[]> {
  if (!persistent) {
    const all: Pet[] = [];
    for (const raw of boardMemory.values()) {
      try { all.push(...JSON.parse(raw) as Pet[]); } catch { /* 壊れた値は無視 */ }
    }
    return all;
  }
  const raw = await redis(['HGETALL', BOARD_KEY]).catch(() => null);
  const all: Pet[] = [];
  const values = Array.isArray(raw)
    ? raw.filter((_, i) => i % 2 === 1)
    : raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : [];
  for (const value of values) {
    try { all.push(...JSON.parse(String(value)) as Pet[]); } catch { /* 壊れた値は無視 */ }
  }
  return all;
}

export async function boardPet(name: string, petId: string, stampAt?: number): Promise<boolean> {
  const pets = await listPets(name);
  const pet = pets.find(p => p.id === petId);
  if (!pet || pet.boarded) return false;
  pet.chosen = false;
  pet.boarded = true;
  if (stampAt !== undefined) pet.boardedAt = stampAt;
  await savePets(name, pets);
  const field = nicknameKey(normalizeNickname(name));
  const mine = await readArray(BOARD_KEY, field, boardMemory);
  await writeArray(BOARD_KEY, field, [...mine.filter(p => p.id !== petId), pet], boardMemory);
  return true;
}

export type BossEggResult = 'received' | 'already' | 'full';

// 配布履歴がある人だけ共闘参加時にペット本体を読むための軽い確認。
export async function hasBossEggRecord(name: string): Promise<boolean> {
  const field = nicknameKey(normalizeNickname(name));
  const raw = persistent
    ? await redis(['HGET', EGG_STAGES_KEY, field]).catch(() => null)
    : eggStagesMemory.get(field) ?? null;
  return raw !== null && raw !== undefined;
}

// ボス卵の配布済み段を、ペット本体とは別のハッシュに記録する。
export async function grantBossEggOnce(name: string, stage: number): Promise<BossEggResult> {
  return serializePet(name, () => grantBossEggOnceLocked(name, stage));
}

async function grantBossEggOnceLocked(name: string, stage: number): Promise<BossEggResult> {
  const field = nicknameKey(normalizeNickname(name));
  const raw = persistent
    ? await redis(['HGET', EGG_STAGES_KEY, field]).catch(() => null)
    : eggStagesMemory.get(field) ?? null;
  let stages: number[] = [];
  try { stages = Array.isArray(JSON.parse(String(raw))) ? JSON.parse(String(raw)) as number[] : []; }
  catch { stages = []; }
  if (stages.includes(stage)) return 'already';

  const pets = await listPets(name);
  const now = Date.now();
  if (!canTakeEgg(pets, now)) return 'full';   // 卵の枠がいっぱい
  pets.push({
    id: crypto.randomUUID(), ownerName: name, species: eggSpeciesForBoss(stage), name: '',
    sex: Math.random() < 0.5 ? 'm' : 'f', hpGene: wildGene(), mpGene: wildGene(),
    lifeGene: wildGene(), warmCount: 0, lastWarmAt: now, hatchedAt: 0,
    boarded: false, boardedAt: 0, eggAt: 0, chosen: false, breedCount: 0, lastBredAt: 0,
    parents: null, bornAt: now,
  });
  await savePets(name, pets);
  stages.push(stage);
  const body = JSON.stringify(stages);
  if (persistent) await redis(['HSET', EGG_STAGES_KEY, field, body]);
  else eggStagesMemory.set(field, body);
  return 'received';
}

export async function unboardPet(name: string, petId: string): Promise<boolean> {
  const pets = await listPets(name);
  const pet = pets.find(p => p.id === petId);
  if (!pet || !pet.boarded) return false;
  pet.boarded = false;
  await savePets(name, pets);
  const field = nicknameKey(normalizeNickname(name));
  const mine = await readArray(BOARD_KEY, field, boardMemory);
  await writeArray(BOARD_KEY, field, mine.filter(p => p.id !== petId), boardMemory);
  return true;
}
