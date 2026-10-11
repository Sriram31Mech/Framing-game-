import type { AiIntent, AiWorldView } from './types';

/**
 * Rule-based utility AI. Scores candidate actions (harvest ready plots, clear failed plots,
 * plant best-suited crop on idle owned land when sowing is open and cash allows,
 * apply pest control on high pressure, sell inventory when price >= personality threshold
 * vs base or produce near expiry, buy affordable well-suited land, borrow conservatively).
 * Returns at most `maxActions` intents, highest utility first. Deterministic for a given `random`.
 */
export function decideAiActions(
  view: AiWorldView,
  random: () => number,
  maxActions: number,
): AiIntent[] {
  void view;
  void random;
  void maxActions;
  throw new Error('not implemented');
}
