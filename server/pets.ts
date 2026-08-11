// 試験中のペット保管。Upstash未設定時はサーバー内メモリへ退避する。
import type { Pet } from '../shared/pets';
import { nicknameKey, normalizeNickname } from '../shared/nickname';
import { persistent, redis } from './upstash';

const PETS_KEY = 'madoken:pets';
const BOARD_KEY = 'madoken:pets:board';
const petMemory = new Map<string, string>();
const boardMemory = new Map<string, string>();

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
  return readArray(PETS_KEY, nicknameKey(normalizeNickname(name)), petMemory);
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

export async function boardPet(name: string, petId: string): Promise<boolean> {
  const pets = await listPets(name);
  const pet = pets.find(p => p.id === petId);
  if (!pet || pet.boarded) return false;
  pet.boarded = true;
  await savePets(name, pets);
  const field = nicknameKey(normalizeNickname(name));
  const mine = await readArray(BOARD_KEY, field, boardMemory);
  await writeArray(BOARD_KEY, field, [...mine.filter(p => p.id !== petId), pet], boardMemory);
  return true;
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
