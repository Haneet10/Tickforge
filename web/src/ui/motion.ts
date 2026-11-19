// Small helpers that keep the screen calm.

/** Move `current` toward `target` with time constant `tau` seconds, independent of frame rate. */
export function ease(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** True when the visitor's system asks for less motion. */
export const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Price direction with a dead band. Trades bounce between the bid and the ask,
 * so colouring every print by its last tick makes prices flicker red and green
 * several times a second. This only changes colour once the price has moved
 * `ticks` away from its most recent high or low.
 */
export class TrendTone {
  private ref = 0;
  private dir: 'up' | 'down' = 'up';
  constructor(private ticks: number) {}
  reset(): void {
    this.ref = 0;
    this.dir = 'up';
  }
  push(price: number): 'up' | 'down' {
    if (!this.ref) this.ref = price;
    if (this.dir === 'up') {
      if (price > this.ref) this.ref = price;
      else if (price <= this.ref - this.ticks) { this.dir = 'down'; this.ref = price; }
    } else {
      if (price < this.ref) this.ref = price;
      else if (price >= this.ref + this.ticks) { this.dir = 'up'; this.ref = price; }
    }
    return this.dir;
  }
}
