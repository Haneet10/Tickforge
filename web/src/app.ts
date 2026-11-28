// Application state: owns the engine, advances it, and mirrors what the UI
// needs into plain arrays once per frame. Panels read from here and never
// touch WebAssembly memory themselves.
import {
  Engine, REJECT_REASONS, Side, Status, Tif,
  type BotParams, type Fill, type KindStats, type Level, type MarketState, type OpenOrder, type OrderResult, type Trade,
} from './engine';
import { money, px, qty } from './fmt';
import { History } from './history';
import { applyToEngine } from './replay/apply';
import { type Action, emptyLog, type SessionLog } from './replay/log';

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
}

export const WARMUP_SECONDS = 45 * 60;
const DEPTH_LEVELS = 160;

export const SCENARIOS: Scenario[] = [
  {
    id: 'crash',
    name: 'Flash crash',
    blurb: 'A fund sells 32,000 shares as a fixed share of volume with no price limit, the mistake behind the May 2010 flash crash. Market makers get run over and pull their quotes.',
    tone: 'down',
  },
  {
    id: 'news-bad',
    name: 'Bad news',
    blurb: 'The stock is suddenly worth 2% less. Informed traders know first. Watch them hit stale bids until the price catches up.',
    tone: 'down',
  },
  {
    id: 'news-good',
    name: 'Good news',
    blurb: 'The stock is suddenly worth 2% more. Anyone left offering at the old price gets picked off.',
    tone: 'up',
  },
  {
    id: 'whale',
    name: 'Whale buyer',
    blurb: 'An institution buys 25,000 shares in even slices over 90 seconds. The price drifts up while it works and partly falls back after.',
    tone: 'up',
  },
  {
    id: 'fat-finger',
    name: 'Fat finger',
    blurb: 'Someone sends a 15,000 share market sell by mistake. It eats through the book in one message.',
    tone: 'down',
  },
  {
    id: 'drought',
    name: 'Liquidity drought',
    blurb: 'Most market makers switch off for a minute. Spreads widen and every order moves the price further.',
    tone: 'warn',
  },
  {
    id: 'storm',
    name: 'Volatility storm',
    blurb: 'Fair value moves three times as fast for two minutes. Quoting gets dangerous.',
    tone: 'warn',
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

/** Something that drives the market instead of the clock: the replay player. */
export interface Driver {
  /** Advance by this many simulated seconds. */
  advance(simSeconds: number): void;
  /** The user tried to change the market. */
  refuse(): void;
}

export const DEFAULT_DIALS = { activity: 1, liquidity: 1, volatility: 1, momentum: true, informed: true, breaker: false };
export const DEFAULT_BOT: BotParams = { gamma: 0.05, kappa: 0.7, horizon: 10, size: 100, maxInventory: 1000 };

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

  speed = 1;
  paused = false;
  xray = true;
  /** When set, UI that could leak hidden information or change the market is locked. */
  challengeActive = false;

  dials = { ...DEFAULT_DIALS };
  bot: BotParams & { enabled: boolean } = { enabled: false, ...DEFAULT_BOT };

  /** The live session, recorded as it happens (see replay/log.ts). */
  log: SessionLog = emptyLog(1, WARMUP_SECONDS);
  /** Simulated microsecond at which the current session began. */
  sessionStartUs = 0;
  /** Set while a replay drives the market. User actions are refused. */
  driver: Driver | null = null;
  /** Suppresses toasts while a replay fast-forwards. */
  private quiet = 0;

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
    if (this.quiet) return;
    this.emit('toast', { text, tone });
  }

  async boot(seed: number): Promise<void> {
    this.engine = await Engine.create(seed);
    this.restart(seed);
  }

  /** Throw the market away and start a new one from the given seed. */
  restart(seed: number, warmupSeconds = WARMUP_SECONDS): void {
    if (this.driver) return this.driver.refuse();
    this.resetMarket(seed, warmupSeconds);
    this.bot.enabled = false;
    this.log = emptyLog(seed, warmupSeconds);
    this.act(this.dialsAction()); // the session starts with whatever dials are set
    this.pull();
    this.emit('restart');
  }

  /** Fresh market, warmed up, with the user's clock and every mirror reset. Records nothing. */
  private resetMarket(seed: number, warmupSeconds: number): void {
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
    if (warmupSeconds >= 600) this.warmup = { seconds: warmupSeconds, ms, messages: this.s.messages };
    this.sessionStart = this.s.time;
    this.sessionStartUs = this.engine.now();
  }

  /** Microseconds since the current session began. */
  sessionTime(): number {
    return this.engine.now() - this.sessionStartUs;
  }

  /** The live recording, closed off at the current instant. */
  currentLog(): SessionLog {
    return { ...this.log, actions: [...this.log.actions], length: Math.max(this.log.length, this.sessionTime()) };
  }

  /**
   * Rebuilds the market from a log, up to `t` microseconds into the session.
   * The engine re-simulates everything from the seed, applying each action
   * on its recorded microsecond, so the result is the original market, not an
   * approximation. Toasts are muted; chart marks are rebuilt.
   * Returns the index of the first action after `t`.
   */
  simulate(log: SessionLog, t: number): number {
    this.quiet++;
    try {
      this.resetMarket(log.seed, log.warmup);
      this.dials = { ...DEFAULT_DIALS };
      this.bot = { enabled: false, ...DEFAULT_BOT };
      // Panels clear now, then rebuild from the fills and trades that follow.
      this.emit('restart');
      if (log.watch) this.engine.watch(log.watch);
      let i = 0;
      for (; i < log.actions.length && log.actions[i].t <= t; i++) {
        this.engine.stepTo(this.sessionStartUs + log.actions[i].t);
        this.apply(log.actions[i].a);
      }
      this.engine.stepTo(this.sessionStartUs + t);
      this.pull();
      return i;
    } finally {
      this.quiet--;
      this.emit('dials');
      this.emit('bot');
    }
  }

  /** Applies a recorded action during playback, at the current instant. */
  playback(a: Action): void {
    this.apply(a);
  }

  /** Stops a replay. With a log, the market continues as that live session. */
  release(continueWith: SessionLog | null): void {
    this.driver = null;
    if (continueWith) {
      this.log = { ...continueWith, actions: [...continueWith.actions] };
      this.log.length = 0;
      delete this.log.watch;
    }
    this.emit('replay');
  }

  /** Advance the market by a slice of real time and refresh the mirrors. */
  frame(realSeconds: number): void {
    if (!this.paused) {
      const sim = Math.min(realSeconds, 0.1) * this.speed;
      if (this.driver) this.driver.advance(sim);
      else this.engine.step(sim);
    }
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

  /**
   * Every change the user makes to the market goes through here: it is
   * recorded with the microsecond it happened, then applied. During a replay
   * it is refused instead.
   */
  private act(a: Action): OrderResult | null {
    if (this.driver) {
      this.driver.refuse();
      return null;
    }
    this.log.actions.push({ t: this.sessionTime(), a });
    return this.apply(a);
  }

  /** Applies an action to the engine and keeps the UI's mirrors in step. */
  private apply(a: Action): OrderResult | null {
    const ordersBefore = this.orders.length;
    const posBefore = this.s.position;
    const r = applyToEngine(this.engine, a);
    switch (a[0]) {
      case 'L': return this.report(a[1] as Side, r!, 'limit');
      case 'M': return this.report(a[1] as Side, r!, 'market');
      case 'T':
        this.toast(`TWAP started: ${a[1] === Side.Buy ? 'buy' : 'sell'} ${qty(a[2])} over ${a[3]}s`, 'info');
        break;
      case 'XA':
        if (ordersBefore) this.toast(`Cancelled ${ordersBefore} order${ordersBefore === 1 ? '' : 's'}`, 'info');
        break;
      case 'F':
        if (r && r.filled > 0) this.toast(`Flattened: ${posBefore > 0 ? 'sold' : 'bought'} ${qty(r.filled)} @ ${px(r.avgPrice)}`, 'info');
        break;
      case 'R':
        this.fills = [];
        this.emit('account-reset');
        break;
      case 'B':
        this.bot = { enabled: a[1] !== 0, gamma: a[2], kappa: a[3], horizon: a[4], size: a[5], maxInventory: a[6] };
        this.emit('bot');
        break;
      case 'D':
        this.dials = { activity: a[1], liquidity: a[2], volatility: a[3], momentum: a[4] !== 0, informed: a[5] !== 0, breaker: a[6] !== 0 };
        this.emit('dials');
        break;
      case 'S': {
        const sc = SCENARIOS[a[1]];
        if (sc) this.toast(`${sc.name} triggered`, sc.tone);
        break;
      }
    }
    this.pull();
    return r;
  }

  limit(side: Side, price: number, quantity: number, tif: Tif = Tif.GTC, postOnly = false): OrderResult | null {
    return this.act(['L', side, Math.round(price), Math.round(quantity), tif, postOnly ? 1 : 0]);
  }
  market(side: Side, quantity: number): OrderResult | null {
    return this.act(['M', side, Math.round(quantity)]);
  }
  twap(side: Side, quantity: number, seconds: number): void {
    this.act(['T', side, Math.round(quantity), seconds]);
  }
  stopAlgo(): void {
    this.act(['AX']);
  }
  cancel(id: number): void {
    this.act(['X', id]);
  }
  cancelAll(): void {
    this.act(['XA']);
  }
  flatten(): void {
    if (this.s.position === 0 && this.orders.length === 0) return;
    this.act(['F']);
  }
  /** Moves the hidden true value: the challenge's surprise news. */
  news(fraction: number): void {
    this.act(['N', fraction]);
  }
  resetAccount(): void {
    if (this.bot.enabled) this.setBot(false);
    this.act(['R']);
  }

  setBot(enabled: boolean): void {
    const b = this.bot;
    this.act(['B', enabled ? 1 : 0, b.gamma, b.kappa, b.horizon, b.size, b.maxInventory]);
  }
  updateBot(): void {
    if (this.bot.enabled) this.setBot(true);
  }

  private dialsAction(): Action {
    const d = this.dials;
    return ['D', d.activity, d.liquidity, d.volatility, d.momentum ? 1 : 0, d.informed ? 1 : 0, d.breaker ? 1 : 0];
  }
  applyDials(): void {
    this.act(this.dialsAction());
  }

  runScenario(id: string): void {
    const i = SCENARIOS.findIndex((x) => x.id === id);
    if (i < 0 || this.challengeActive) return;
    this.act(['S', i]);
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
