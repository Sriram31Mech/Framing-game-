/** Deterministic PRNG utilities. Never use Math.random() in simulation code. */

/** 32-bit string/number hash (e.g. FNV-1a) combining all parts. */
export function hashSeed(...parts: (string | number)[]): number {
  void parts;
  throw new Error('not implemented');
}

/** Returns a deterministic generator of floats in [0,1) (e.g. mulberry32). */
export function createRng(seed: number): () => number {
  void seed;
  throw new Error('not implemented');
}

/** Convenience: createRng(hashSeed(...parts)). */
export function rngFor(...parts: (string | number)[]): () => number {
  void parts;
  throw new Error('not implemented');
}
