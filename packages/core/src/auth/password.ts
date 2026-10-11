/**
 * Password hashing with Node's scrypt (docs/IMPLEMENTATION.md §5):
 * N = 2^15, r = 8, p = 1, 16-byte random salt, 64-byte key, constant-time verification.
 * Stored format: `scrypt$<N>$<r>$<p>$<salt b64>$<key b64>` so parameters can be raised later.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt needs 128 · N · r bytes; allow headroom over Node's 32 MiB default. */
const maxmem = (n: number, r: number) => 256 * n * r;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: maxmem(N, R),
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: maxmem(n, r),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A valid hash of a random password, verified against when a username does not exist so
 * that login timing does not reveal which usernames are registered.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
