// Plays a recorded session back in the terminal.
//
// The player takes over the clock: each frame it moves a cursor through the
// session, applying recorded actions on their exact microsecond, and the
// whole terminal (chart, book, tape, account) follows as if it were live.
// Seeking backwards re-simulates from the seed. That sounds expensive, but
// the engine runs 45 minutes of warm-up plus a ten-minute session in well
// under 100 ms, so it is faster than storing snapshots and exact by
// construction.
import type { App, Driver } from '../app';
import { Engine, type BacktestRun } from '../engine';
import { applyToEngine } from './apply';
import type { SessionLog } from './log';

export interface Preview {
  /** Per-second mid price and the account's P&L, both in ticks, from session start. */
  mid: Float32Array;
  pnl: Float32Array;
  /** Final P&L, ticks. */
  final: number;
  ms: number;
}

export type PlayerState = 'playing' | 'ended';

export interface PlayerHooks {
  /** Called a few times a second and whenever something visible changes. */
  onChange(): void;
  onEnd(result: BacktestRun | null): void;
}

export class Player implements Driver {
  readonly log: SessionLog;
  /** The session to go back to on exit, or null to keep whatever is there. */
  readonly restore: SessionLog | null;
  cursor = 0; // µs into the session
  state: PlayerState = 'playing';
  preview: Preview | null = null;
  result: BacktestRun | null = null;
  /** Wall time the last seek took, for the status line. */
  lastSeekMs = 0;
  tookOver = false;

  private next = 0; // index of the next action to apply
  private app: App;
  private hooks: PlayerHooks;
  private refusedAt = 0;

  constructor(app: App, log: SessionLog, restore: SessionLog | null, hooks: PlayerHooks) {
    this.app = app;
    this.log = log;
    this.restore = restore;
    this.hooks = hooks;
  }

  get length(): number {
    return this.log.length;
  }

  get canTakeOver(): boolean {
    return !this.log.watch;
  }

  start(): void {
    this.app.driver = this;
    this.seek(0);
    this.app.emit('replay');
    void this.buildPreview();
  }

  advance(simSeconds: number): void {
    if (this.state === 'ended') return;
    const target = Math.min(this.length, this.cursor + simSeconds * 1e6);
    const actions = this.log.actions;
    const app = this.app;
    while (this.next < actions.length && actions[this.next].t <= target) {
      const x = actions[this.next++];
      app.engine.stepTo(app.sessionStartUs + x.t);
      app.playback(x.a);
    }
    app.engine.stepTo(app.sessionStartUs + target);
    this.cursor = target;
    if (this.cursor >= this.length) this.end();
  }

  /** Jumps to any point in the session. */
  seek(t: number): void {
    const target = Math.max(0, Math.min(this.length, Math.round(t)));
    const t0 = performance.now();
    this.next = this.app.simulate(this.log, target);
    this.lastSeekMs = performance.now() - t0;
    this.cursor = target;
    this.result = null;
    this.state = 'playing';
    if (target >= this.length) this.end();
    this.hooks.onChange();
  }

  refuse(): void {
    const now = performance.now();
    if (now - this.refusedAt < 1500) return;
    this.refusedAt = now;
    this.app.toast(this.canTakeOver ? 'This is a replay. Press Take over to trade from here.' : 'This is a strategy replay. Exit it to trade.', 'info');
  }

  /** Keep the market exactly as it is and continue live, recording from the actions so far. */
  takeOver(): void {
    if (!this.canTakeOver) return;
    const kept = { ...this.log, actions: this.log.actions.filter((x) => x.t <= this.cursor) };
    this.tookOver = true;
    this.app.release(kept);
  }

  /** Leave the replay and put back the session that was running before it. */
  exit(): void {
    if (this.restore) {
      const restore = this.restore;
      this.app.driver = null;
      this.app.simulate(restore, restore.length);
      this.app.release(restore);
    } else {
      this.app.release(null);
    }
  }

  private end(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.result = this.log.watch ? this.app.engine.watchResult() : null;
    this.hooks.onEnd(this.result);
    this.hooks.onChange();
  }

  /**
   * Runs the whole session once in a second, off-screen engine to draw the
   * price and P&L under the scrubber, like thumbnails on a video timeline.
   */
  private async buildPreview(): Promise<void> {
    const t0 = performance.now();
    const e = await scoutEngine();
    const log = this.log;
    e.reset(log.seed);
    e.step(log.warmup);
    e.userReset();
    const start = e.now();
    const firstBar = e.state().barCount;
    if (log.watch) e.watch(log.watch);
    const seconds = Math.ceil(log.length / 1e6);
    const mid = new Float32Array(seconds + 1);
    const pnl = new Float32Array(seconds + 1);
    mid[0] = e.state().mid;
    let i = 0;
    for (let s = 1; s <= seconds; s++) {
      const until = Math.min(log.length, s * 1e6);
      for (; i < log.actions.length && log.actions[i].t <= until; i++) {
        e.stepTo(start + log.actions[i].t);
        applyToEngine(e, log.actions[i].a);
      }
      e.stepTo(start + until);
    }
    // The engine already sampled every second; read them back in one go.
    const st = e.state();
    const from = Math.max(firstBar, st.barBase);
    const samples = e.samples(from, st.barCount);
    const n = Math.min(seconds, samples.length / 8);
    for (let k = 0; k < n; k++) {
      mid[k + 1] = samples[k * 8];
      pnl[k + 1] = samples[k * 8 + 2];
    }
    for (let k = n + 1; k <= seconds; k++) {
      mid[k] = mid[k - 1];
      pnl[k] = pnl[k - 1];
    }
    const result = log.watch ? e.watchResult() : null;
    this.preview = { mid, pnl, final: result ? result.pnl * 100 : st.pnl, ms: performance.now() - t0 };
    this.hooks.onChange();
  }
}

let scout: Promise<Engine> | null = null;
function scoutEngine(): Promise<Engine> {
  scout ??= Engine.create(1);
  return scout;
}
