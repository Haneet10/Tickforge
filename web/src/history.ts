// Per-second history copied out of the engine, in growable typed arrays.
//
// The engine produces one bar and one sample per simulated second. The chart
// aggregates these into whatever candle interval is selected.
import { BAR_FIELDS, SAMPLE_FIELDS } from './engine';

export class History {
  /** Completed seconds. Index n is the bar still forming. */
  n = 0;
  private cap = 4096;

  open = new Int32Array(this.cap);
  high = new Int32Array(this.cap);
  low = new Int32Array(this.cap);
  close = new Int32Array(this.cap);
  volume = new Int32Array(this.cap);
  buyVolume = new Int32Array(this.cap);
  halted = new Uint8Array(this.cap);
  mid = new Float32Array(this.cap);
  value = new Float32Array(this.cap);
  pnl = new Float32Array(this.cap);
  position = new Float32Array(this.cap);
  botBid = new Float32Array(this.cap);
  botAsk = new Float32Array(this.cap);
  /** Cumulative price x volume and volume, for VWAP over any window. */
  cumPV = new Float64Array(this.cap);
  cumV = new Float64Array(this.cap);

  clear(): void {
    this.n = 0;
  }

  private grow(need: number): void {
    if (need < this.cap) return;
    let cap = this.cap;
    while (cap <= need) cap *= 2;
    const g = <T extends Int32Array | Uint8Array | Float32Array | Float64Array>(a: T): T => {
      const b = new (a.constructor as any)(cap) as T;
      b.set(a);
      return b;
    };
    this.open = g(this.open);
    this.high = g(this.high);
    this.low = g(this.low);
    this.close = g(this.close);
    this.volume = g(this.volume);
    this.buyVolume = g(this.buyVolume);
    this.halted = g(this.halted);
    this.mid = g(this.mid);
    this.value = g(this.value);
    this.pnl = g(this.pnl);
    this.position = g(this.position);
    this.botBid = g(this.botBid);
    this.botAsk = g(this.botAsk);
    this.cumPV = g(this.cumPV);
    this.cumV = g(this.cumV);
    this.cap = cap;
  }

  private setBar(i: number, b: Int32Array, o: number): void {
    this.open[i] = b[o];
    this.high[i] = b[o + 1];
    this.low[i] = b[o + 2];
    this.close[i] = b[o + 3];
    this.volume[i] = b[o + 4];
    this.buyVolume[i] = b[o + 5];
    this.halted[i] = b[o + 7];
  }

  append(bars: Int32Array, samples: Float32Array): void {
    const count = bars.length / BAR_FIELDS;
    this.grow(this.n + count + 1);
    for (let k = 0; k < count; k++) {
      const i = this.n + k;
      this.setBar(i, bars, k * BAR_FIELDS);
      const s = k * SAMPLE_FIELDS;
      this.mid[i] = samples[s];
      this.value[i] = samples[s + 1];
      this.pnl[i] = samples[s + 2];
      this.position[i] = samples[s + 3];
      this.botBid[i] = samples[s + 6];
      this.botAsk[i] = samples[s + 7];
      // Typical price is a fine stand-in for per-trade VWAP at one-second resolution.
      const typical = (this.high[i] + this.low[i] + this.close[i]) / 3;
      this.cumPV[i] = (i ? this.cumPV[i - 1] : 0) + typical * this.volume[i];
      this.cumV[i] = (i ? this.cumV[i - 1] : 0) + this.volume[i];
    }
    this.n += count;
  }

  /** Overwrite the provisional bar at index n with the second in progress. */
  setLive(bar: Int32Array, mid: number, value: number, pnl: number, position: number, botBid: number, botAsk: number): void {
    this.grow(this.n + 1);
    const i = this.n;
    this.setBar(i, bar, 0);
    this.mid[i] = mid;
    this.value[i] = value;
    this.pnl[i] = pnl;
    this.position[i] = position;
    this.botBid[i] = botBid;
    this.botAsk[i] = botAsk;
    const typical = (this.high[i] + this.low[i] + this.close[i]) / 3;
    this.cumPV[i] = (i ? this.cumPV[i - 1] : 0) + typical * this.volume[i];
    this.cumV[i] = (i ? this.cumV[i - 1] : 0) + this.volume[i];
  }

  /** Session VWAP up to and including second i. */
  vwapAt(i: number): number {
    return this.cumV[i] > 0 ? this.cumPV[i] / this.cumV[i] : this.close[i];
  }
}
