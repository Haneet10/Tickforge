// Application state: owns the engine, advances it, and mirrors what the UI
// needs into plain arrays once per frame. Panels read from here and never
// touch WebAssembly memory themselves.
import {
  AlgoStyle, Engine, REJECT_REASONS, Side, Status, Tif,
  type BotParams, type Fill, type KindStats, type Level, type MarketState, type OpenOrder, type OrderResult, type Trade,
} from './engine';
import { money, px, qty } from './fmt';
import { History } from './history';

export type Tone = 'up' | 'down' | 'warn' | 'info';

export interface ChartMark {
  time: number; // simulated seconds
  label: string;
  tone: Tone;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  tone: Tone;
  run(app: App): void;
}

export const WARMUP_SECONDS = 45 * 60;
const DEPTH_LEVELS = 160;

export const SCENARIOS: Scenario[] = [
  {
    id: 'crash',
    name: 'Flash crash',
    blurb: 'A fund sells 32,000 shares as a fixed share of volume with no price limit, the mistake behind the May 2010 flash crash. Market makers get run over and pull their quotes.',
    tone: 'down',
    run: (app) => app.engine.crash(1),
  },
  {
    id: 'news-bad',
    name: 'Bad news',
    blurb: 'The stock is suddenly worth 2% less. Informed traders know first. Watch them hit stale bids until the price catches up.',
    tone: 'down',
    run: (app) => app.engine.news(-0.02),
  },
  {
    id: 'news-good',
    name: 'Good news',
    blurb: 'The stock is suddenly worth 2% more. Anyone left offering at the old price gets picked off.',
    tone: 'up',
    run: (app) => app.engine.news(0.02),
  },
  {
    id: 'whale',
    name: 'Whale buyer',
    blurb: 'An institution buys 25,000 shares in even slices over 90 seconds. The price drifts up while it works and partly falls back after.',
    tone: 'up',
    run: (app) => app.engine.whale(Side.Buy, 25000, 90),
  },
  {
    id: 'fat-finger',
    name: 'Fat finger',
    blurb: 'Someone sends a 15,000 share market sell by mistake. It eats through the book in one message.',
    tone: 'down',
    run: (app) => app.engine.fatFinger(Side.Sell, 15000),
  },
  {
    id: 'drought',
    name: 'Liquidity drought',
    blurb: 'Most market makers switch off for a minute. Spreads widen and every order moves the price further.',
    tone: 'warn',
    run: (app) => app.engine.drought(60),
  },
  {
    id: 'storm',
    name: 'Volatility storm',
    blurb: 'Fair value moves three times as fast for two minutes. Quoting gets dangerous.',
    tone: 'warn',
    run: (app) => app.engine.volBurst(120, 3),
  },
];

const SCENARIO_LABELS: Record<number, string> = {
  1: 'NEWS',
  2: 'FLASH CRASH',
  3: 'DROUGHT',
  4: 'WHALE',
  5: 'FAT FINGER',
  6: 'VOL STORM',
};

type Listener = (payload?: any) => void;

export class App {
  engine!: Engine;
  s!: MarketState;
  bids: Level[] = [];
  asks: Level[] = [];
  history = new History();
  tape: Trade[] = [];
  fills: Fill[] = [];
  orders: OpenOrder[] = [];
  marks: ChartMark[] = [];

  speed = 4;
  paused = false;
  xray = true;
  /** When set, UI that could leak hidden information or change the market is locked. */
  challengeActive = false;

  dials = { activity: 1, liquidity: 1, volatility: 1, momentum: true, informed: true, breaker: false };
  bot: BotParams & { enabled: boolean } = { enabled: false, gamma: 0.05, kappa: 0.7, horizon: 10, size: 100, maxInventory: 1000 };

  warmup = { seconds: WARMUP_SECONDS, ms: 0, messages: 0 };
  /** Simulated second at which the user's session (and the visible day) began. */
  sessionStart = 0;

  private tapeSeen = 0;
  private fillSeen = 0;
  private eventSeen = 0;
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  emit(event: string, payload?: any): void {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }
  toast(text: string, tone: Tone = 'info'): void {
    this.emit('toast', { text, tone });
  }

  async boot(seed: number): Promise<void> {
    this.engine = await Engine.create(seed);
    this.restart(seed);
  }

  /** Throw the market away and start a new one from the given seed. */
  restart(seed: number, warmupSeconds = WARMUP_SECONDS): void {
    this.engine.reset(seed);
    const t0 = performance.now();
    this.engine.step(warmupSeconds);
    const ms = performance.now() - t0;
    this.engine.userReset(); // the user's clock and statistics start now, not at the warm-up
    this.history.clear();
    this.tape = [];
    this.fills = [];
    this.marks = [];
    this.orders = [];
    this.tapeSeen = 0;
    this.fillSeen = 0;
    this.s = this.engine.state();
    this.eventSeen = this.s.eventCount;
    this.warmup = { seconds: warmupSeconds, ms, messages: this.s.messages };
    this.sessionStart = this.s.time;
    this.applyDials();
    this.bot.enabled = false;
    this.pull();
    this.emit('restart');
  }

  /** Advance the market by a slice of real time and refresh the mirrors. */
  frame(realSeconds: number): void {
    if (!this.paused) this.engine.step(Math.min(realSeconds, 0.1) * this.speed);
    this.pull();
  }

  pull(): void {
    const e = this.engine;
    const s = (this.s = e.state());
    e.depth(Side.Buy, DEPTH_LEVELS, this.bids);
    e.depth(Side.Sell, DEPTH_LEVELS, this.asks);

    const hist = this.history;
    if (s.barCount > hist.n) {
      const from = Math.max(hist.n, s.barBase);
      hist.append(e.bars(from, s.barCount), e.samples(from, s.barCount));
    }
    hist.setLive(e.liveBar(), s.mid, s.fundamental, s.pnl, s.position, s.botEnabled ? s.botBid : 0, s.botEnabled ? s.botAsk : 0);

    if (s.tapeCount > this.tapeSeen) {
      const fresh = e.tape(this.tapeSeen);
      this.tapeSeen = s.tapeCount;
      this.tape.push(...fresh);
      if (this.tape.length > 400) this.tape.splice(0, this.tape.length - 300);
      this.emit('trades', fresh);
    }

    if (s.fillCount > this.fillSeen) {
      const fresh = e.fills(this.fillSeen);
      this.fillSeen = s.fillCount;
      this.fills.push(...fresh);
      if (this.fills.length > 600) this.fills.splice(0, this.fills.length - 500);
      this.emit('fills', fresh);
    }

    this.orders = e.orders();

    if (s.eventCount > this.eventSeen) {
      for (const ev of e.events(this.eventSeen)) this.onEngineEvent(ev.time, ev.code, ev.a, ev.b);
      this.eventSeen = s.eventCount;
    }
  }

  private onEngineEvent(time: number, code: number, a: number, b: number): void {
    switch (code) {
      case 1:
        this.marks.push({ time, label: a < b ? 'HALT · LIMIT DOWN' : 'HALT · LIMIT UP', tone: 'warn' });
        this.toast(`Circuit breaker: trading halted at ${px(a)}, more than ${(Math.abs(a - b) / b * 100).toFixed(1)}% from the reference price`, 'warn');
        break;
      case 2:
        this.toast('Trading resumed', 'info');
        break;
      case 3:
        this.marks.push({ time, label: SCENARIO_LABELS[a] ?? 'EVENT', tone: a === 1 ? (b > 0 ? 'up' : 'down') : a === 4 ? 'up' : a === 3 || a === 6 ? 'warn' : 'down' });
        break;
      case 4:
        if (a > 0) this.toast(`The big order is done: ${qty(a)} shares, on average ${px(Math.abs(b))} ${b > 0 ? 'worse' : 'better'} than the price when it started`, 'info');
        break;
      case 5:
        this.toast(`Your algo finished: ${qty(a)} shares, ${Math.abs(b).toFixed(1)} ticks ${b > 0 ? 'worse' : 'better'} than arrival (${money(-b * a)})`, b > 0 ? 'warn' : 'up');
        break;
    }
    this.emit('marks');
  }

  // ------------------------------------------------------------ trading ----

  private report(side: Side, r: OrderResult, kind: string): OrderResult {
    const verb = side === Side.Buy ? 'Bought' : 'Sold';
    if (r.status === Status.Rejected) {
      this.toast(`Order rejected: ${REJECT_REASONS[r.reject] ?? 'unknown reason'}`, 'warn');
    } else if (r.filled > 0 && r.resting > 0) {
      this.toast(`${verb} ${qty(r.filled)} @ ${px(r.avgPrice)}, ${qty(r.resting)} resting`, side === Side.Buy ? 'up' : 'down');
    } else if (r.filled > 0) {
      this.toast(`${verb} ${qty(r.filled)} @ ${px(r.avgPrice)}${kind === 'market' ? this.slippageNote(side, r) : ''}`, side === Side.Buy ? 'up' : 'down');
    } else if (r.status === Status.Cancelled) {
      this.toast('Nothing traded: no liquidity at that price', 'warn');
    }
    this.pull();
    return r;
  }

  private slippageNote(side: Side, r: OrderResult): string {
    const ref = this.s.mid;
    const slip = (side === Side.Buy ? r.avgPrice - ref : ref - r.avgPrice) * r.filled;
    return slip > 0.5 ? ` · cost ${money(slip, false)} vs mid` : '';
  }

  limit(side: Side, price: number, quantity: number, tif: Tif = Tif.GTC, postOnly = false): OrderResult {
    return this.report(side, this.engine.limit(side, price, quantity, tif, postOnly), 'limit');
  }
  market(side: Side, quantity: number): OrderResult {
    return this.report(side, this.engine.market(side, quantity), 'market');
  }
  twap(side: Side, quantity: number, seconds: number): void {
    this.engine.algo(side, quantity, AlgoStyle.Twap, seconds);
    this.toast(`TWAP started: ${side === Side.Buy ? 'buy' : 'sell'} ${qty(quantity)} over ${seconds}s`, 'info');
    this.pull();
  }
  cancel(id: number): void {
    this.engine.cancel(id);
    this.pull();
  }
  cancelAll(): void {
    const n = this.engine.cancelAll();
    if (n) this.toast(`Cancelled ${n} order${n === 1 ? '' : 's'}`, 'info');
    this.pull();
  }
  flatten(): void {
    const pos = this.s.position;
    if (pos === 0 && this.orders.length === 0) return;
    const r = this.engine.flatten();
    if (r.filled > 0) this.toast(`Flattened: ${pos > 0 ? 'sold' : 'bought'} ${qty(r.filled)} @ ${px(r.avgPrice)}`, 'info');
    this.pull();
  }
  resetAccount(): void {
    this.setBot(false);
    this.engine.userReset();
    this.fills = [];
    this.pull();
    this.emit('account-reset');
  }

  setBot(enabled: boolean): void {
    this.bot.enabled = enabled;
    this.engine.bot(enabled, this.bot);
    this.pull();
    this.emit('bot');
  }
  updateBot(): void {
    if (this.bot.enabled) this.engine.bot(true, this.bot);
  }

  applyDials(): void {
    const d = this.dials;
    this.engine.dials(d.activity, d.liquidity, d.volatility, d.momentum, d.informed);
    this.engine.breaker(d.breaker, 0.035);
  }

  runScenario(id: string): void {
    const sc = SCENARIOS.find((x) => x.id === id);
    if (!sc || this.challengeActive) return;
    sc.run(this);
    this.toast(`${sc.name} triggered`, sc.tone);
    this.pull();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.paused = false;
    this.emit('speed');
  }
  togglePause(): void {
    this.paused = !this.paused;
    this.emit('speed');
  }
  setXray(on: boolean): void {
    this.xray = on;
    document.documentElement.classList.toggle('xray', on);
    this.emit('xray');
  }

  kinds(): KindStats[] {
    return this.engine.kinds();
  }
}
