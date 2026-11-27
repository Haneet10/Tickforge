// Typed wrapper around the WebAssembly engine.
//
// The module exports plain C functions and writes bulk data into its own
// linear memory. This file is the only place that knows the memory layout.

import wasmUrl from '/tickforge.wasm?url';

export const TICK = 0.01; // dollars per tick

export const enum Side {
  Buy = 0,
  Sell = 1,
}

export const enum Tif {
  GTC = 0,
  IOC = 1,
  FOK = 2,
}

export const enum Status {
  Resting = 0,
  Partial = 1,
  Filled = 2,
  Cancelled = 3,
  Rejected = 4,
}

export const enum AlgoStyle {
  Twap = 0,
  Pov = 1,
  Sweep = 2,
}

export const KINDS = ['You', 'Retail', 'Market makers', 'Momentum', 'Value', 'Informed', 'Institution'] as const;
export const KIND_TAGS = ['YOU', 'RTL', 'MM', 'MOM', 'VAL', 'INF', 'INST'] as const;

export const REJECT_REASONS = [
  '',
  'Quantity must be positive',
  'Price is too far from the market',
  'Post-only order would have traded',
  'Not enough liquidity to fill in full',
  'The order book is full',
  'Trading is halted',
] as const;

export interface OrderResult {
  id: number;
  status: Status;
  reject: number;
  filled: number;
  resting: number;
  avgPrice: number; // ticks, 0 if nothing filled
}

export interface MarketState {
  time: number;
  last: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  mid: number;
  micro: number;
  fundamental: number;
  sigma: number;
  volume: number;
  trades: number;
  messages: number;
  vwap: number;
  high: number;
  low: number;
  open: number;
  haltRemaining: number;
  liquidity: number;
  liveOrders: number;
  position: number;
  cash: number;
  pnl: number;
  pnlSpread: number;
  pnlInventory: number;
  fees: number;
  peak: number;
  maxDrawdown: number;
  maxLong: number;
  maxShort: number;
  markout1: number;
  markout5: number;
  markout30: number;
  twoSided: number;
  pnlSum: number;
  pnlSumSq: number;
  pnlSamples: number;
  userVolume: number;
  userMakerVolume: number;
  userTrades: number;
  botEnabled: boolean;
  botReservation: number;
  botHalfSpread: number;
  botBid: number;
  botAsk: number;
  algoActive: boolean;
  algoSide: Side;
  algoTarget: number;
  algoDone: number;
  algoArrival: number;
  algoAvg: number;
  algoShortfall: number;
  barCount: number;
  barBase: number;
  tapeCount: number;
  fillCount: number;
  eventCount: number;
  flow: number;
  sigmaSlow: number;
  takerFee: number;
  makerRebate: number;
  volMultiplier: number;
}

export interface Level {
  price: number;
  qty: number;
  orders: number;
  mine: number;
}

export interface Trade {
  time: number;
  price: number;
  qty: number;
  side: Side; // the aggressor
  takerKind: number;
  makerKind: number;
}

export interface Fill {
  time: number;
  side: Side;
  price: number;
  qty: number;
  maker: boolean;
  mid: number;
  fee: number;
  orderId: number;
}

export interface OpenOrder {
  id: number;
  side: Side;
  price: number;
  remaining: number;
  original: number;
  queueAhead: number;
}

export interface MarketEvent {
  time: number;
  code: number; // 1 halt, 2 resume, 3 scenario start, 4 scenario end, 5 algo done
  a: number;
  b: number;
}

export interface KindStats {
  traders: number;
  position: number;
  pnl: number;
  volume: number;
  makerVolume: number;
}

export interface BotParams {
  gamma: number;
  kappa: number;
  horizon: number;
  size: number;
  maxInventory: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  tf_create(seed: number): void;
  tf_step(seconds: number): void;
  tf_state(): number;
  tf_depth_ptr(): number;
  tf_depth(side: number, max: number): number;
  tf_bars(from: number): number;
  tf_samples(from: number): number;
  tf_live_bar(): number;
  tf_tape_ptr(): number;
  tf_tape(from: number): number;
  tf_fills_ptr(): number;
  tf_fills(from: number): number;
  tf_events_ptr(): number;
  tf_events(from: number): number;
  tf_orders_ptr(): number;
  tf_orders(): number;
  tf_kinds(): number;
  tf_limit(side: number, price: number, qty: number, tif: number, postOnly: number): number;
  tf_market(side: number, qty: number): number;
  tf_cancel(id: number): number;
  tf_cancel_all(): number;
  tf_flatten(): number;
  tf_algo(side: number, qty: number, style: number, param: number): void;
  tf_algo_cancel(): void;
  tf_user_reset(): void;
  tf_bot(enabled: number, gamma: number, kappa: number, horizon: number, size: number, maxInv: number): void;
  tf_news(fraction: number): void;
  tf_crash(intensity: number): void;
  tf_drought(seconds: number): void;
  tf_whale(side: number, qty: number, seconds: number): void;
  tf_fat_finger(side: number, qty: number): void;
  tf_vol_burst(seconds: number, multiple: number): void;
  tf_dials(activity: number, liquidity: number, volatility: number, momentum: number, informed: number): void;
  tf_breaker(enabled: number, band: number): void;
  tf_catalog(): number;
  tf_catalog_len(): number;
  tf_backtest(strategy: number, seed: number, warmup: number, duration: number, scenario: number, scenarioAt: number,
    p0: number, p1: number, p2: number, p3: number, p4: number): number;
}

let compiled: Promise<WebAssembly.Module> | null = null;

function compile(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () =>
    // Some static hosts serve .wasm with the wrong MIME type.
    WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()),
  );
  return compiled;
}

// The engine is built for WASI but never does I/O. These stubs satisfy the
// three imports libc pulls in.
const wasiStubs = {
  wasi_snapshot_preview1: {
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_write: () => 0,
  },
};

export interface StrategyParam {
  key: string;
  label: string;
  unit: string;
  def: number;
  min: number;
  max: number;
  step: number;
  help: string;
}

export interface StrategyInfo {
  id: number;
  key: string;
  name: string;
  style: string;
  blurb: string;
  params: StrategyParam[];
}

/** Scenario keys in engine order (tf::ScenarioKind). */
export const BACKTEST_SCENARIOS = ['none', 'crash', 'news-bad', 'news-good', 'whale', 'fat-finger', 'drought', 'storm'] as const;

export interface BacktestSpec {
  strategy: number;
  params: number[];
  seed: number;
  warmup: number;
  duration: number;
  scenario: number;
  scenarioAt: number;
}

export interface BacktestRun {
  seed: number;
  seconds: number;
  pnl: number; // dollars
  spread: number;
  inventory: number;
  fees: number;
  sharpe: number;
  maxDrawdown: number;
  volume: number;
  trades: number;
  makerShare: number;
  maxPosition: number;
  timeInMarket: number;
  markout: [number, number, number]; // ticks per share
  marketMove: number; // dollars per share
  equity: Float64Array; // dollars, one per second
  position: Float64Array;
  mid: Float64Array;
}

const BACKTEST_HEADER = 24;

export const BAR_FIELDS = 8;
export const SAMPLE_FIELDS = 8;

export class Engine {
  private x: Exports;
  seed = 1;

  private constructor(x: Exports) {
    this.x = x;
  }

  /** Each Engine is its own WebAssembly instance with its own market. */
  static async create(seed: number): Promise<Engine> {
    const module = await compile();
    const instance = await WebAssembly.instantiate(module, wasiStubs);
    const x = instance.exports as unknown as Exports;
    x._initialize();
    const engine = new Engine(x);
    engine.reset(seed);
    return engine;
  }

  reset(seed: number): void {
    this.seed = seed;
    this.x.tf_create(seed);
  }

  step(seconds: number): void {
    this.x.tf_step(seconds);
  }

  // Views are created per call: linear memory can grow, which detaches old buffers.
  private f64(ptr: number, n: number): Float64Array {
    return new Float64Array(this.x.memory.buffer, ptr, n);
  }
  private i32(ptr: number, n: number): Int32Array {
    return new Int32Array(this.x.memory.buffer, ptr, n);
  }

  state(): MarketState {
    const s = this.f64(this.x.tf_state(), 62);
    return {
      time: s[0], last: s[1], bid: s[2], ask: s[3], bidQty: s[4], askQty: s[5], mid: s[6], micro: s[7],
      fundamental: s[8], sigma: s[9], volume: s[10], trades: s[11], messages: s[12], vwap: s[13],
      high: s[14], low: s[15], open: s[16], haltRemaining: s[17], liquidity: s[18], liveOrders: s[19],
      position: s[20], cash: s[21], pnl: s[22], pnlSpread: s[23], pnlInventory: s[24], fees: s[25],
      peak: s[26], maxDrawdown: s[27], maxLong: s[28], maxShort: s[29],
      markout1: s[30], markout5: s[31], markout30: s[32], twoSided: s[33],
      pnlSum: s[34], pnlSumSq: s[35], pnlSamples: s[36],
      userVolume: s[37], userMakerVolume: s[38], userTrades: s[39],
      botEnabled: s[40] !== 0, botReservation: s[41], botHalfSpread: s[42], botBid: s[43], botAsk: s[44],
      algoActive: s[45] !== 0, algoSide: s[46] as Side, algoTarget: s[47], algoDone: s[48],
      algoArrival: s[49], algoAvg: s[50], algoShortfall: s[51],
      barCount: s[52], barBase: s[53], tapeCount: s[54], fillCount: s[55], eventCount: s[56],
      flow: s[57], sigmaSlow: s[58], takerFee: s[59], makerRebate: s[60], volMultiplier: s[61],
    };
  }

  depth(side: Side, max: number, out: Level[]): Level[] {
    const n = this.x.tf_depth(side, max);
    const d = this.i32(this.x.tf_depth_ptr(), n * 4);
    out.length = n;
    for (let i = 0; i < n; i++) {
      const o = (out[i] ??= { price: 0, qty: 0, orders: 0, mine: 0 });
      o.price = d[i * 4];
      o.qty = d[i * 4 + 1];
      o.orders = d[i * 4 + 2];
      o.mine = d[i * 4 + 3];
    }
    return out;
  }

  /** One-second bars [from, to) as a copy: open, high, low, close, volume, buy volume, trades, halted. */
  bars(from: number, to: number): Int32Array {
    if (to <= from) return new Int32Array(0);
    return this.i32(this.x.tf_bars(from), (to - from) * BAR_FIELDS).slice();
  }

  /** Per-second samples [from, to): mid, fundamental, pnl, position, sigma, spread, bot bid, bot ask. */
  samples(from: number, to: number): Float32Array {
    if (to <= from) return new Float32Array(0);
    return new Float32Array(this.x.memory.buffer, this.x.tf_samples(from), (to - from) * SAMPLE_FIELDS).slice();
  }

  liveBar(): Int32Array {
    return this.i32(this.x.tf_live_bar(), BAR_FIELDS);
  }

  tape(from: number): Trade[] {
    const n = this.x.tf_tape(from);
    const d = this.f64(this.x.tf_tape_ptr(), n * 6);
    const out: Trade[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * 6;
      out[i] = { time: d[k], price: d[k + 1], qty: d[k + 2], side: d[k + 3] as Side, takerKind: d[k + 4], makerKind: d[k + 5] };
    }
    return out;
  }

  fills(from: number): Fill[] {
    const n = this.x.tf_fills(from);
    const d = this.f64(this.x.tf_fills_ptr(), n * 8);
    const out: Fill[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * 8;
      out[i] = {
        time: d[k], side: d[k + 1] as Side, price: d[k + 2], qty: d[k + 3], maker: d[k + 4] !== 0,
        mid: d[k + 5], fee: d[k + 6], orderId: d[k + 7],
      };
    }
    return out;
  }

  events(from: number): MarketEvent[] {
    const n = this.x.tf_events(from);
    const d = this.f64(this.x.tf_events_ptr(), n * 4);
    const out: MarketEvent[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { time: d[i * 4], code: d[i * 4 + 1], a: d[i * 4 + 2], b: d[i * 4 + 3] };
    return out;
  }

  orders(): OpenOrder[] {
    const n = this.x.tf_orders();
    const d = this.f64(this.x.tf_orders_ptr(), n * 6);
    const out: OpenOrder[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * 6;
      out[i] = { id: d[k], side: d[k + 1] as Side, price: d[k + 2], remaining: d[k + 3], original: d[k + 4], queueAhead: d[k + 5] };
    }
    return out;
  }

  kinds(): KindStats[] {
    const d = this.f64(this.x.tf_kinds(), KINDS.length * 5);
    const out: KindStats[] = [];
    for (let k = 0; k < KINDS.length; k++) {
      out.push({ traders: d[k * 5], position: d[k * 5 + 1], pnl: d[k * 5 + 2], volume: d[k * 5 + 3], makerVolume: d[k * 5 + 4] });
    }
    return out;
  }

  private result(ptr: number): OrderResult {
    const r = this.f64(ptr, 6);
    return { id: r[0], status: r[1] as Status, reject: r[2], filled: r[3], resting: r[4], avgPrice: r[3] > 0 ? r[5] / r[3] : 0 };
  }

  limit(side: Side, price: number, qty: number, tif: Tif = Tif.GTC, postOnly = false): OrderResult {
    return this.result(this.x.tf_limit(side, Math.round(price), Math.round(qty), tif, postOnly ? 1 : 0));
  }
  market(side: Side, qty: number): OrderResult {
    return this.result(this.x.tf_market(side, Math.round(qty)));
  }
  cancel(id: number): boolean {
    return this.x.tf_cancel(id) !== 0;
  }
  cancelAll(): number {
    return this.x.tf_cancel_all();
  }
  flatten(): OrderResult {
    return this.result(this.x.tf_flatten());
  }
  algo(side: Side, qty: number, style: AlgoStyle, param: number): void {
    this.x.tf_algo(side, qty, style, param);
  }
  algoCancel(): void {
    this.x.tf_algo_cancel();
  }
  userReset(): void {
    this.x.tf_user_reset();
  }
  bot(enabled: boolean, p: BotParams): void {
    this.x.tf_bot(enabled ? 1 : 0, p.gamma, p.kappa, p.horizon, p.size, p.maxInventory);
  }

  news(fraction: number): void {
    this.x.tf_news(fraction);
  }
  crash(intensity = 1): void {
    this.x.tf_crash(intensity);
  }
  drought(seconds: number): void {
    this.x.tf_drought(seconds);
  }
  whale(side: Side, qty: number, seconds: number): void {
    this.x.tf_whale(side, qty, seconds);
  }
  fatFinger(side: Side, qty: number): void {
    this.x.tf_fat_finger(side, qty);
  }
  volBurst(seconds: number, multiple: number): void {
    this.x.tf_vol_burst(seconds, multiple);
  }
  dials(activity: number, liquidity: number, volatility: number, momentum: boolean, informed: boolean): void {
    this.x.tf_dials(activity, liquidity, volatility, momentum ? 1 : 0, informed ? 1 : 0);
  }
  breaker(enabled: boolean, band: number): void {
    this.x.tf_breaker(enabled ? 1 : 0, band);
  }

  // ---------------------------------------------------------- backtests ----

  catalog(): StrategyInfo[] {
    const ptr = this.x.tf_catalog();
    const bytes = new Uint8Array(this.x.memory.buffer, ptr, this.x.tf_catalog_len());
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** Runs a whole session in a fresh market; the live market is untouched. */
  backtest(b: BacktestSpec): BacktestRun {
    const p = [...b.params, 0, 0, 0, 0, 0];
    const ptr = this.x.tf_backtest(b.strategy, b.seed, b.warmup, b.duration, b.scenario, b.scenarioAt, p[0], p[1], p[2], p[3], p[4]);
    const head = this.f64(ptr, BACKTEST_HEADER);
    const n = head[0] + 1;
    const series = this.f64(ptr + BACKTEST_HEADER * 8, 3 * n).slice();
    return {
      seconds: head[0], pnl: head[1], spread: head[2], inventory: head[3], fees: head[4], sharpe: head[5],
      maxDrawdown: head[6], volume: head[7], trades: head[8], makerShare: head[9], maxPosition: head[10],
      timeInMarket: head[11], markout: [head[12], head[13], head[14]], marketMove: head[15], seed: head[16],
      equity: series.subarray(0, n), position: series.subarray(n, 2 * n), mid: series.subarray(2 * n, 3 * n),
    };
  }
}
