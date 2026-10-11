/** Deterministic PRNG utilities. Never use Math.random() in simulation code. */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a hash combining all parts. Each part is serialised with a type tag and
 * separated, so `hashSeed('a', 1)` differs from `hashSeed('a1')` and `hashSeed(1, 'a')`.
 */
export function hashSeed(...parts: (string | number)[]): number {
  let hash = FNV_OFFSET_BASIS;
  for (const part of parts) {
    const text = typeof part === 'number' ? `n${part}` : `s${part}`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME);
    }
    // Part separator (0x1f, ASCII unit separator) so part boundaries matter.
    hash ^= 0x1f;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Returns a deterministic generator of floats in [0,1) (mulberry32). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: createRng(hashSeed(...parts)). */
export function rngFor(...parts: (string | number)[]): () => number {
  return createRng(hashSeed(...parts));
}

/**
 * Fast stateless integer hash of up to three integers to a float in [0,1).
 * Used for lattice noise where string hashing would be too slow (terrain meshes sample it
 * hundreds of thousands of times).
 */
export function hashToUnit(seed: number, a: number, b: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Uniform float in [min, max). */
export function randomBetween(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

/** Uniform integer in [min, max] (inclusive). */
export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
