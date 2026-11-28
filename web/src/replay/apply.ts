// The one place a recorded action becomes engine calls. The live terminal,
// the replay player and the timeline preview all go through here, so a
// replay can never interpret an action differently from how it was taken.
import { AlgoStyle, type Engine, type OrderResult, Side, type Tif } from '../engine';
import type { Action } from './log';

/** The scenario menu, in the order 'S' actions index it. */
export const SCENARIO_RUNS: ((e: Engine) => void)[] = [
  (e) => e.crash(1),
  (e) => e.news(-0.02),
  (e) => e.news(0.02),
  (e) => e.whale(Side.Buy, 25000, 90),
  (e) => e.fatFinger(Side.Sell, 15000),
  (e) => e.drought(60),
  (e) => e.volBurst(120, 3),
];

export const DIALS_BREAKER_BAND = 0.035;

/** Applies one action to an engine. Returns the order result for order actions. */
export function applyToEngine(e: Engine, a: Action): OrderResult | null {
  switch (a[0]) {
    case 'L': return e.limit(a[1] as Side, a[2], a[3], a[4] as Tif, a[5] !== 0);
    case 'M': return e.market(a[1] as Side, a[2]);
    case 'X': e.cancel(a[1]); return null;
    case 'XA': e.cancelAll(); return null;
    case 'F': return e.flatten();
    case 'T': e.algo(a[1] as Side, a[2], AlgoStyle.Twap, a[3]); return null;
    case 'AX': e.algoCancel(); return null;
    case 'R': e.userReset(); return null;
    case 'B': e.bot(a[1] !== 0, { gamma: a[2], kappa: a[3], horizon: a[4], size: a[5], maxInventory: a[6] }); return null;
    case 'S': SCENARIO_RUNS[a[1]]?.(e); return null;
    case 'D':
      e.dials(a[1], a[2], a[3], a[4] !== 0, a[5] !== 0);
      e.breaker(a[6] !== 0, DIALS_BREAKER_BAND);
      return null;
    case 'N': e.news(a[1]); return null;
  }
}
