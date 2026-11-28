// The Strategy Lab: backtest the built-in strategies across many simulated
// sessions and see the whole distribution of outcomes, not one lucky run.
//
// Runs happen in a Web Worker (worker.ts) on its own engine instance. Every
// strategy runs on the same seeds, so the leaderboard is a paired comparison.
import { cssVar, fitCanvas, h, setText } from '../dom';
import { BACKTEST_SCENARIOS, type BacktestRun, type BacktestSpec, type StrategyInfo } from '../engine';
import type { SessionLog } from '../replay/log';
import type { LabReply, LabRequest } from './worker';

const SCENARIO_NAMES: Record<(typeof BACKTEST_SCENARIOS)[number], string> = {
  none: 'Calm market',
  crash: 'Flash crash',
  'news-bad': 'Bad news',
  'news-good': 'Good news',
  whale: 'Whale buyer',
  'fat-finger': 'Fat finger',
  drought: 'Liquidity drought',
  storm: 'Volatility storm',
};
const SEED_OPTIONS = [10, 25, 50, 100];
const LENGTH_OPTIONS = [5, 10, 30]; // minutes
const FIRST_SEED = 1000;
const WARMUP = 300;
const SCENARIO_AT = 0.4;

interface Config {
  seeds: number;
  minutes: number;
  scenario: number;
}

interface Summary {
  runs: number;
  mean: number;
  stdev: number;
  t: number;
  win: number;
  median: number;
  p05: number;
  p95: number;
  sharpe: number;
  drawdown: number;
  maker: number;
  markout5: number;
  volume: number;
  spread: number;
  inventory: number;
  fees: number;
}

interface Result {
  config: Config;
  params: number[];
  runs: BacktestRun[];
  born: number[]; // performance.now() when each run arrived, for the fade-in
  expected: number;
  ms: number;
}

const configKey = (c: Config) => `${c.seeds}/${c.minutes}/${c.scenario}`;

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/** Same definitions as tf::summarize in engine/src/backtest.cpp. */
export function summarize(runs: BacktestRun[]): Summary {
  const n = runs.length;
  const pnl = runs.map((r) => r.pnl);
  const mean = n ? pnl.reduce((a, b) => a + b, 0) / n : 0;
  const stdev = n > 1 ? Math.sqrt(pnl.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...pnl].sort((a, b) => a - b);
  const avg = (f: (r: BacktestRun) => number) => (n ? runs.reduce((a, r) => a + f(r), 0) / n : 0);
  const volume = runs.reduce((a, r) => a + r.volume, 0);
  return {
    runs: n,
    mean,
    stdev,
    t: stdev > 0 ? mean / (stdev / Math.sqrt(n)) : 0,
    win: n ? pnl.filter((x) => x > 0).length / n : 0,
    median: percentile(sorted, 0.5),
    p05: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
    sharpe: avg((r) => r.sharpe),
    drawdown: avg((r) => r.maxDrawdown),
    maker: volume ? runs.reduce((a, r) => a + r.makerShare * r.volume, 0) / volume : 0,
    markout5: avg((r) => r.markout[1]),
    volume: avg((r) => r.volume),
    spread: avg((r) => r.spread),
    inventory: avg((r) => r.inventory),
    fees: avg((r) => r.fees),
  };
}

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function dollars(v: number, sign = true): string {
  const body = '$' + usd0.format(Math.abs(Math.round(v)));
  if (Math.round(v) === 0) return '$0';
  return v < 0 ? '−' + body : sign ? '+' + body : body;
}
function num(v: number, digits = 1): string {
  const body = Math.abs(v).toFixed(digits);
  return v < 0 && Number(body) !== 0 ? '−' + body : body;
}
const toneOf = (v: number, eps = 0.5) => (v > eps ? 'up' : v < -eps ? 'down' : 'flat');
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Lab {
  readonly el: HTMLElement;
  private worker: Worker | null = null;
  private catalog: StrategyInfo[] = [];
  private params: number[][] = [];
  private selected = 0;
  private config: Config = { seeds: 25, minutes: 10, scenario: 0 };
  private results = new Map<number, Result>();
  private batch = 0;
  private pending: { strategy: number; count: number }[] = [];
  private running = false;
  private opened = false;
  private hoverSeed = -1;
  private raf = 0;
  private yLo = -50;
  private yHi = 50;
  private onClose: () => void;
  private onWatch: (log: SessionLog) => void;
  private watchBtn = h('button.btn.tiny.lab-watch', { type: 'button', disabled: true, title: 'Open the median session in the terminal and watch the strategy trade it, order by order' }, 'Watch median session');

  // Elements.
  private rail = h('div.lab-strats', { role: 'radiogroup', 'aria-label': 'Strategy' });
  private paramBox = h('div.lab-params');
  private blurb = h('p.lab-blurb');
  private stats = h('div.lab-stats');
  private fan = h('canvas.lab-fan', { 'aria-label': 'Equity curves for every simulated session' });
  private fanTip = h('div.lab-tip', { hidden: true });
  private dist = h('canvas.lab-dist', { 'aria-label': 'Distribution of session profit and loss' });
  private attrib = h('div.lab-attrib');
  private board = h('tbody');
  private runBtn = h('button.btn.solid.lab-run', { type: 'button' }, 'Run backtest');
  private allBtn = h('button.btn.lab-all', { type: 'button' }, 'Compare all');
  private progress = h('div.lab-progress', h('i'));
  private status = h('span.lab-status', { 'aria-live': 'polite' });
  private fanTitle = h('span.lab-fan-title');
  private distNote = h('span.lab-legend');
  private boardNote = h('p.hint.lab-board-note');
  private statEls = new Map<string, { v: HTMLElement; s: HTMLElement }>();
  private sparks: HTMLCanvasElement[] = [];

  constructor(onClose: () => void, onWatch: (log: SessionLog) => void) {
    this.onClose = onClose;
    this.onWatch = onWatch;
    this.el = this.build();
    document.body.append(this.el);
  }

  // ------------------------------------------------------------- shell ----

  private build(): HTMLElement {
    const scenario = h('select.lab-select', { 'aria-label': 'Market scenario' },
      ...BACKTEST_SCENARIOS.map((k, i) => h('option', { value: String(i) }, SCENARIO_NAMES[k])));
    scenario.addEventListener('change', () => {
      this.config.scenario = Number(scenario.value);
      this.refreshAll();
    });
    const segs = (label: string, options: number[], fmt: (v: number) => string, get: () => number, set: (v: number) => void) => {
      const group = h('div.seg-group', { role: 'group', 'aria-label': label });
      const btns = options.map((v) => {
        const b = h('button.seg', { type: 'button', 'aria-pressed': String(get() === v) }, fmt(v));
        b.addEventListener('click', () => {
          set(v);
          btns.forEach((x, i) => x.setAttribute('aria-pressed', String(options[i] === get())));
          this.refreshAll();
        });
        group.append(b);
        return b;
      });
      return h('div.lab-field', h('span.label', label), group);
    };

    this.runBtn.addEventListener('click', () => this.run([this.selected]));
    this.allBtn.addEventListener('click', () => this.run(this.catalog.map((s) => s.id)));
    const back = h('button.btn.ghost.lab-back', { type: 'button', 'aria-label': 'Back to the terminal' },
      h('span', { 'aria-hidden': 'true' }, '←'), ' Terminal');
    back.addEventListener('click', () => this.close());

    const statDefs: [string, string, string][] = [
      ['mean', 'Mean P&L', 'Average profit per session after fees, flat at the end.'],
      ['t', 't-stat', 'Mean P&L over its standard error. Above about 2, the edge is unlikely to be luck.'],
      ['win', 'Sessions won', 'Share of sessions that finished with a profit.'],
      ['sharpe', 'Sharpe', 'Annualised from one-second P&L changes, averaged over sessions. High-frequency strategies score high on this scale.'],
      ['dd', 'Max drawdown', 'Average worst peak-to-trough fall within a session.'],
      ['markout', 'Markout 5s', 'How far the mid moved in your favour five seconds after each fill, in ticks. Negative means the other side knew more.'],
    ];
    for (const [key, label, title] of statDefs) {
      const v = h('span.lab-stat-v', '—');
      const s = h('span.lab-stat-s', ' ');
      this.statEls.set(key, { v, s });
      this.stats.append(h('div.lab-stat', { title }, h('span.label', label), v, s));
    }

    const fanWrap = h('div.lab-fan-wrap', this.fan, this.fanTip);
    this.fan.addEventListener('pointermove', (e) => this.hoverFan(e));
    this.fan.addEventListener('pointerleave', () => this.setHover(-1));
    this.fan.addEventListener('click', () => this.watchSeed(this.hoverSeed));
    this.dist.addEventListener('click', () => this.watchSeed(this.hoverSeed));
    this.watchBtn.addEventListener('click', () => this.watchSeed(this.medianSeed()));
    this.dist.addEventListener('pointermove', (e) => this.hoverDist(e));
    this.dist.addEventListener('pointerleave', () => this.setHover(-1));
    window.addEventListener('resize', () => this.opened && this.requestDraw());

    const el = h('section.lab', { id: 'lab', 'aria-label': 'Strategy lab', tabindex: '-1', hidden: true },
      h('header.lab-top',
        back,
        h('div.lab-title', h('span.lab-kicker', 'TICKFORGE'), h('h1', 'Strategy lab')),
        h('div.lab-controls',
          h('div.lab-field', h('span.label', 'Market'), scenario),
          segs('Sessions', SEED_OPTIONS, String, () => this.config.seeds, (v) => (this.config.seeds = v)),
          segs('Length', LENGTH_OPTIONS, (v) => `${v}m`, () => this.config.minutes, (v) => (this.config.minutes = v)),
          h('div.lab-actions', this.allBtn, this.runBtn)),
        this.progress),
      h('div.lab-body',
        h('aside.lab-side',
          h('div.lab-side-head', h('span.label', 'Strategy'), h('span.label.dim', 'Mean P&L')),
          this.rail,
          this.blurb,
          this.paramBox),
        h('div.lab-main',
          this.stats,
          h('section.lab-card.lab-fan-card',
            h('div.lab-card-head', h('h2', 'Equity, every session'), this.fanTitle,
              h('span.lab-legend', h('i.sw.med'), 'median', h('i.sw.band'), '10–90%', h('i.sw.seed'), 'one session'),
              this.watchBtn),
            fanWrap),
          h('div.lab-split',
            h('section.lab-card',
              h('div.lab-card-head', h('h2', 'Where sessions finished'), this.distNote),
              h('div.lab-dist-wrap', this.dist)),
            h('section.lab-card',
              h('div.lab-card-head', h('h2', 'Where the money came from'), h('span.lab-legend', 'per session, average')),
              this.attrib)),
          h('section.lab-card',
            h('div.lab-card-head', h('h2', 'Leaderboard'), h('span.lab-legend', 'same seeds for every strategy')),
            h('div.lab-board-wrap',
              h('table.tbl.lab-board',
                h('thead', h('tr',
                  h('th', 'Strategy'), h('th', 'Mean P&L'), h('th', { title: 'Mean over standard error' }, 't'),
                  h('th', 'Won'), h('th', 'Sharpe'), h('th', 'Drawdown'), h('th', 'Volume'),
                  h('th', { title: 'Share of volume traded passively' }, 'Maker'),
                  h('th', { title: 'Average 5 second markout, ticks' }, 'Markout'), h('th.spark-col', 'Median path'))),
                this.board)),
            this.boardNote),
          h('footer.lab-foot', this.status))));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('select')) this.close();
    });
    return el;
  }

  // ------------------------------------------------------------ worker ----

  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<LabReply>) => this.onReply(e.data);
    setText(this.status, 'Starting a second engine for the lab…');
  }

  private onReply(msg: LabReply): void {
    if (msg.type === 'error') {
      setText(this.status, `The lab engine could not start: ${msg.message}`);
      return;
    }
    if (msg.type === 'ready') {
      this.catalog = msg.catalog;
      this.params = this.catalog.map((s) => s.params.map((p) => p.def));
      this.buildRail();
      this.selectStrategy(this.selected);
      setText(this.status, 'Ready.');
      // First visit: show something straight away.
      this.run(this.catalog.map((s) => s.id));
      return;
    }
    if (msg.batch !== this.batch) return;
    if (msg.type === 'result') {
      let i = msg.index;
      for (const p of this.pending) {
        if (i < p.count) {
          const r = this.results.get(p.strategy);
          if (r) {
            r.runs.push(msg.run);
            r.born.push(performance.now());
          }
          break;
        }
        i -= p.count;
      }
      this.onProgress(msg.index + 1);
    } else if (msg.type === 'done') {
      this.running = false;
      const total = this.pending.reduce((a, p) => a + p.count, 0);
      const minutes = total * this.config.minutes;
      setText(this.status, `${total} sessions, ${(minutes / 60).toFixed(1)} simulated hours, in ${(msg.ms / 1000).toFixed(1)} s on a background thread. Seeds ${FIRST_SEED} to ${FIRST_SEED + this.config.seeds - 1}.`);
      this.progress.classList.remove('on');
      this.syncButtons();
      this.refreshAll();
    }
  }

  private run(ids: number[]): void {
    if (!this.catalog.length) return;
    this.ensureWorker();
    const cfg = { ...this.config };
    const jobs: BacktestSpec[] = [];
    this.pending = [];
    for (const id of ids) {
      this.results.set(id, { config: cfg, params: [...this.params[id]], runs: [], born: [], expected: cfg.seeds, ms: 0 });
      this.pending.push({ strategy: id, count: cfg.seeds });
      for (let k = 0; k < cfg.seeds; k++)
        jobs.push({ strategy: id, params: this.params[id], seed: FIRST_SEED + k, warmup: WARMUP, duration: cfg.minutes * 60, scenario: cfg.scenario, scenarioAt: SCENARIO_AT });
    }
    this.batch += 1;
    this.running = true;
    this.syncButtons();
    this.progress.classList.add('on');
    (this.progress.firstElementChild as HTMLElement).style.transform = 'scaleX(0)';
    setText(this.status, `Simulating ${jobs.length} sessions…`);
    this.worker!.postMessage({ type: 'run', batch: this.batch, jobs } satisfies LabRequest);
    this.refreshAll();
  }

  private lastProgressUi = 0;
  private onProgress(done: number): void {
    const total = this.pending.reduce((a, p) => a + p.count, 0);
    (this.progress.firstElementChild as HTMLElement).style.transform = `scaleX(${(done / total).toFixed(3)})`;
    // Numbers refresh a few times a second; the canvas fades each new line in.
    const now = performance.now();
    if (now - this.lastProgressUi > 250) {
      this.lastProgressUi = now;
      this.refreshNumbers();
    }
    this.requestDraw();
  }

  private syncButtons(): void {
    setText(this.runBtn, this.running ? 'Running…' : 'Run backtest');
    this.runBtn.disabled = this.running;
    this.allBtn.disabled = this.running;
  }

  // ----------------------------------------------------- strategy rail ----

  private buildRail(): void {
    this.rail.replaceChildren();
    this.sparks = [];
    this.catalog.forEach((s, i) => {
      const val = h('span.lab-strat-val', '—');
      const b = h('button.lab-strat', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-id': String(s.id) },
        h('span.lab-strat-name', s.name), val, h('span.lab-strat-style', s.style));
      b.addEventListener('click', () => this.selectStrategy(i));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const next = (i + (e.key === 'ArrowDown' ? 1 : this.catalog.length - 1)) % this.catalog.length;
        this.selectStrategy(next);
        (this.rail.children[next] as HTMLElement).focus();
      });
      this.rail.append(b);
    });
  }

  private selectStrategy(i: number): void {
    this.selected = i;
    [...this.rail.children].forEach((b, k) => {
      b.setAttribute('aria-checked', String(k === i));
      (b as HTMLElement).tabIndex = k === i ? 0 : -1;
    });
    const s = this.catalog[i];
    if (!s) return;
    setText(this.blurb, s.blurb);
    this.paramBox.replaceChildren(...s.params.map((_p, k) => this.paramControl(i, k)));
    this.hoverSeed = -1;
    this.refreshAll();
  }

  private paramControl(si: number, k: number): HTMLElement {
    const p = this.catalog[si].params[k];
    const get = () => this.params[si][k];
    const set = (v: number) => {
      this.params[si][k] = v;
      this.refreshAll();
    };
    if (p.min === 0 && p.max === 1 && p.step === 1) {
      const input = h('input', { type: 'checkbox' });
      input.checked = get() > 0.5;
      input.addEventListener('change', () => set(input.checked ? 1 : 0));
      return h('div.lab-param', { title: p.help },
        h('label.switch.small', input, h('span.track'), h('span.name', p.label)),
        h('p.lab-param-help', p.help));
    }
    const fmt = (v: number) => {
      const digits = p.step < 0.01 ? 3 : p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0;
      return `${v.toFixed(digits)}${p.unit ? (p.unit === 'σ' ? ' σ' : ` ${p.unit}`) : ''}`;
    };
    const val = h('span.val', fmt(get()));
    const input = h('input', { type: 'range', min: String(p.min), max: String(p.max), step: String(p.step), value: String(get()), 'aria-label': p.label });
    input.addEventListener('input', () => {
      setText(val, fmt(Number(input.value)));
      set(Number(input.value));
    });
    const reset = h('button.lab-param-reset', { type: 'button', title: `Reset to ${fmt(p.def)}`, 'aria-label': `Reset ${p.label}` }, '↺');
    reset.addEventListener('click', () => {
      input.value = String(p.def);
      setText(val, fmt(p.def));
      set(p.def);
    });
    return h('div.slider.lab-param', { title: p.help },
      h('div.slider-head', h('span.label', p.label), h('span.lab-param-right', reset, val)),
      input);
  }

  // --------------------------------------------------------- refreshing ----

  /** The result shown for a strategy, if it matches the current settings. */
  private current(id: number): Result | null {
    const r = this.results.get(id);
    if (!r || configKey(r.config) !== configKey(this.config)) return null;
    return r;
  }
  private stale(id: number): boolean {
    const r = this.current(id);
    return !!r && r.params.some((v, k) => v !== this.params[id][k]);
  }

  private refreshAll(): void {
    this.refreshNumbers();
    this.requestDraw();
  }

  private refreshNumbers(): void {
    if (!this.catalog.length) return;
    const id = this.catalog[this.selected].id;
    const r = this.current(id);
    const s = r && r.runs.length ? summarize(r.runs) : null;
    this.watchBtn.disabled = !r || !r.runs.length;
    const put = (key: string, v: string, sub: string, cls = '') => {
      const e = this.statEls.get(key)!;
      setText(e.v, v);
      setText(e.s, sub || ' ');
      const c = `lab-stat-v ${cls}`.trim();
      if (e.v.className !== c) e.v.className = c;
    };
    if (!s) {
      for (const k of this.statEls.keys()) put(k, '—', '');
      put('mean', '—', this.running ? 'simulating…' : 'not run with these settings');
    } else {
      put('mean', dollars(s.mean), `± ${dollars(s.stdev, false)} across sessions`, toneOf(s.mean));
      const verdict = s.runs < 5 ? 'too few sessions' : Math.abs(s.t) >= 2 ? (s.t > 0 ? 'a real edge, probably' : 'reliably loses') : 'could be luck';
      put('t', num(s.t, 2), verdict, Math.abs(s.t) >= 2 ? toneOf(s.t, 0) : '');
      put('win', `${Math.round(s.win * 100)}%`, `${Math.round(s.win * s.runs)} of ${s.runs}`);
      put('sharpe', num(s.sharpe, 0), 'annualised');
      put('dd', dollars(s.drawdown, false), `worst 5% finish ${dollars(s.p05)}`);
      put('markout', num(s.markout5, 2), `${Math.round(s.maker * 100)}% passive fills`, toneOf(s.markout5, 0.05));
    }
    const sc = SCENARIO_NAMES[BACKTEST_SCENARIOS[this.config.scenario]];
    setText(this.fanTitle, `${this.catalog[this.selected].name} · ${sc} · ${this.config.minutes} min${this.stale(id) ? ' · parameters changed, run again' : ''}`);
    this.fanTitle.classList.toggle('warn', this.stale(id));
    setText(this.distNote, s ? `median ${dollars(s.median)} · 90% between ${dollars(s.p05)} and ${dollars(s.p95)}` : '');

    // Rail values.
    this.catalog.forEach((st, i) => {
      const rr = this.current(st.id);
      const v = this.rail.children[i]?.querySelector('.lab-strat-val') as HTMLElement | null;
      if (!v) return;
      const m = rr && rr.runs.length ? summarize(rr.runs).mean : null;
      setText(v, m === null ? '—' : dollars(m));
      v.className = `lab-strat-val ${m === null ? 'dim' : toneOf(m)}`;
    });

    this.renderAttribution(s);
    this.renderBoard();
  }

  private renderAttribution(s: Summary | null): void {
    const rows: [string, number, string][] = s
      ? [
          ['Spread captured', s.spread, 'Edge against the mid at the moment of each fill. Positive when you buy below and sell above it.'],
          ['Inventory', s.inventory, 'What holding a position earned or lost as the mid moved.'],
          ['Fees and rebates', -s.fees, 'Taker fees paid minus maker rebates earned.'],
          ['Total', s.mean, 'Spread + inventory − fees. Exact, not an estimate.'],
        ]
      : [];
    const max = Math.max(1, ...rows.map((r) => Math.abs(r[1])));
    if (this.attrib.children.length !== 4) {
      this.attrib.replaceChildren(...['Spread captured', 'Inventory', 'Fees and rebates', 'Total'].map((label) =>
        h('div.lab-attr-row', h('span.lab-attr-label', label), h('div.lab-attr-track', h('i.lab-attr-bar')), h('span.lab-attr-val', '—'))));
    }
    [...this.attrib.children].forEach((row, i) => {
      const bar = row.querySelector('.lab-attr-bar') as HTMLElement;
      const val = row.querySelector('.lab-attr-val') as HTMLElement;
      const r = rows[i];
      (row as HTMLElement).title = r ? r[2] : '';
      row.classList.toggle('total', i === 3);
      if (!r) {
        bar.style.transform = 'scaleX(0)';
        setText(val, '—');
        return;
      }
      const frac = Math.abs(r[1]) / max;
      bar.style.transform = `scaleX(${frac.toFixed(4)})`;
      bar.classList.toggle('neg', r[1] < 0);
      setText(val, dollars(r[1]));
      val.className = `lab-attr-val ${toneOf(r[1])}`;
    });
  }

  private renderBoard(): void {
    const rows = this.catalog.map((st) => {
      const r = this.current(st.id);
      return { st, r, s: r && r.runs.length ? summarize(r.runs) : null };
    });
    if (this.board.children.length !== rows.length) {
      this.board.replaceChildren();
      this.sparks = [];
      for (const { st } of rows) {
        const spark = h('canvas.lab-spark', { 'aria-hidden': 'true' });
        this.sparks.push(spark);
        const tr = h('tr', { tabindex: '0', 'data-id': String(st.id) },
          h('td', st.name), h('td'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td.spark-col', spark));
        tr.addEventListener('click', () => this.selectStrategy(st.id));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.selectStrategy(st.id); });
        this.board.append(tr);
      }
    }
    const best = Math.max(...rows.map((x) => (x.s ? x.s.mean : -Infinity)));
    rows.forEach(({ st, s }, i) => {
      const tr = this.board.children[i] as HTMLElement;
      tr.classList.toggle('sel', st.id === this.catalog[this.selected].id);
      tr.classList.toggle('best', !!s && s.mean === best && s.runs > 1);
      const cells = [...tr.children].slice(1, 9) as HTMLElement[];
      const vals: [string, string][] = s
        ? [
            [dollars(s.mean), toneOf(s.mean)], [num(s.t, 1), Math.abs(s.t) >= 2 ? toneOf(s.t, 0) : 'dim'],
            [`${Math.round(s.win * 100)}%`, ''], [num(s.sharpe, 0), ''], [dollars(s.drawdown, false), ''],
            [usd0.format(Math.round(s.volume)), ''], [`${Math.round(s.maker * 100)}%`, ''], [num(s.markout5, 2), toneOf(s.markout5, 0.05)],
          ]
        : Array(8).fill(['—', 'dim']);
      cells.forEach((c, k) => {
        setText(c, vals[k][0]);
        c.className = vals[k][1];
      });
    });
    const missing = rows.filter((x) => !x.s).length;
    setText(this.boardNote, missing === rows.length
      ? 'Press Compare all to run every strategy on the same sessions.'
      : missing ? `${missing} strateg${missing === 1 ? 'y has' : 'ies have'} not been run with these settings yet.` : 'Each row ran the same sessions: same seeds, same scenario, same timing. Differences come from the strategy, not the luck of the draw.');
  }

  // ------------------------------------------------------------ drawing ----

  private requestDraw(): void {
    if (!this.raf && this.opened) this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.raf = 0;
    if (!this.opened || !this.catalog.length) return;
    const animating = this.drawFan();
    this.drawDist();
    this.drawSparks();
    if (animating) this.requestDraw();
  }

  private fanGeom() {
    const { w, h: ht } = fitCanvas(this.fan);
    const L = 54, R = 14, T = 14, B = 24;
    return { w, ht, L, R, T, B };
  }

  /** Draws the equity fan. Returns true while something is still easing. */
  private drawFan(): boolean {
    const ctx = this.fan.getContext('2d')!;
    const { w, h: ht, dpr } = fitCanvas(this.fan);
    const { L, R, T, B } = this.fanGeom();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);
    const id = this.catalog[this.selected].id;
    const r = this.current(id);
    const runs = r?.runs ?? [];
    const seconds = this.config.minutes * 60;
    const now = performance.now();
    let animating = false;

    // Target y-range from the 2nd to 98th percentile of every sample, eased.
    let lo = -50, hi = 50;
    if (runs.length) {
      const all: number[] = [];
      for (const run of runs) for (let i = 0; i < run.equity.length; i += 5) all.push(run.equity[i]);
      all.sort((a, b) => a - b);
      lo = Math.min(0, percentile(all, 0.01));
      hi = Math.max(0, percentile(all, 0.99));
      const pad = Math.max(20, (hi - lo) * 0.12);
      lo -= pad;
      hi += pad;
    }
    const k = reduceMotion() ? 1 : 0.16;
    this.yLo += (lo - this.yLo) * k;
    this.yHi += (hi - this.yHi) * k;
    if (Math.abs(lo - this.yLo) > 0.5 || Math.abs(hi - this.yHi) > 0.5) animating = true;
    const x = (s: number) => L + (s / seconds) * (w - L - R);
    const y = (v: number) => T + (1 - (v - this.yLo) / (this.yHi - this.yLo)) * (ht - T - B);

    // Grid and axes.
    ctx.font = `10.5px ${cssVar('--mono')}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--faint');
    ctx.strokeStyle = cssVar('--line');
    ctx.lineWidth = 1;
    const step = niceStep((this.yHi - this.yLo) / 5);
    ctx.textAlign = 'right';
    for (let v = Math.ceil(this.yLo / step) * step; v <= this.yHi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L, yy);
      ctx.lineTo(w - R, yy);
      ctx.stroke();
      ctx.fillText(dollars(v, false), L - 8, yy);
    }
    ctx.textAlign = 'center';
    const perLabel = (w - L - R) / this.config.minutes; // pixels per minute
    const minuteStep = [1, 2, 5, 10].find((m) => m * perLabel >= 44) ?? 10;
    for (let m = 0; m <= this.config.minutes; m += minuteStep) {
      const xx = Math.round(x(m * 60)) + 0.5;
      ctx.fillText(`${m}m`, Math.min(Math.max(xx, L + 8), w - R - 10), ht - B / 2 + 2);
    }
    ctx.strokeStyle = cssVar('--line-strong');
    ctx.beginPath();
    ctx.moveTo(L, Math.round(y(0)) + 0.5);
    ctx.lineTo(w - R, Math.round(y(0)) + 0.5);
    ctx.stroke();

    // Scenario marker.
    if (this.config.scenario > 0) {
      const xx = Math.round(x(Math.round(SCENARIO_AT * seconds))) + 0.5;
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = cssVar('--dim');
      ctx.beginPath();
      ctx.moveTo(xx, T);
      ctx.lineTo(xx, ht - B);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = cssVar('--dim');
      ctx.textAlign = 'left';
      ctx.font = `600 9.5px ${cssVar('--sans')}`;
      ctx.fillText(SCENARIO_NAMES[BACKTEST_SCENARIOS[this.config.scenario]].toUpperCase(), xx + 6, T + 6);
      ctx.font = `10.5px ${cssVar('--mono')}`;
    }

    if (!runs.length) {
      ctx.fillStyle = cssVar('--faint');
      ctx.textAlign = 'center';
      ctx.fillText(this.running ? 'Simulating sessions…' : 'Press Run backtest to simulate these settings', (L + w - R) / 2, (T + ht - B) / 2 - 14);
      return animating;
    }

    // One faint line per session, tinted by how it finished, fading in as it arrives.
    const up = cssVar('--up'), down = cssVar('--down');
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    const stride = Math.max(1, Math.floor(seconds / (w - L - R)));
    runs.forEach((run, i) => {
      const age = reduceMotion() ? 1 : Math.min(1, (now - r!.born[i]) / 450);
      if (age < 1) animating = true;
      const hovered = run.seed === this.hoverSeed;
      ctx.globalAlpha = (hovered ? 1 : this.hoverSeed >= 0 ? 0.1 : runs.length > 50 ? 0.16 : 0.24) * age;
      ctx.strokeStyle = hovered ? cssVar('--text') : run.pnl >= 0 ? up : down;
      if (hovered) return; // drawn last, on top
      strokePath(ctx, run.equity, stride, x, y);
    });
    ctx.globalAlpha = 1;

    // 10–90% band and the median, once there are enough sessions to mean anything.
    if (runs.length >= 5) {
      const n = runs[0].equity.length;
      const p10: number[] = [], p50: number[] = [], p90: number[] = [], xs: number[] = [];
      const col: number[] = [];
      for (let s = 0; s < n; s += stride) {
        col.length = 0;
        for (const run of runs) col.push(run.equity[s]);
        col.sort((a, b) => a - b);
        xs.push(s);
        p10.push(percentile(col, 0.1));
        p50.push(percentile(col, 0.5));
        p90.push(percentile(col, 0.9));
      }
      ctx.fillStyle = 'rgba(255, 178, 36, 0.09)';
      ctx.beginPath();
      xs.forEach((s, i) => (i ? ctx.lineTo(x(s), y(p90[i])) : ctx.moveTo(x(s), y(p90[i]))));
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(x(xs[i]), y(p10[i]));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = cssVar('--amber');
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      xs.forEach((s, i) => (i ? ctx.lineTo(x(s), y(p50[i])) : ctx.moveTo(x(s), y(p50[i]))));
      ctx.stroke();
      const last = p50[p50.length - 1];
      ctx.fillStyle = cssVar('--amber');
      ctx.beginPath();
      ctx.arc(x(xs[xs.length - 1]), y(last), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const hov = runs.find((run) => run.seed === this.hoverSeed);
    if (hov) {
      ctx.strokeStyle = cssVar('--text');
      ctx.lineWidth = 1.5;
      strokePath(ctx, hov.equity, stride, x, y);
    }
    return animating;
  }

  private hoverFan(e: PointerEvent): void {
    const r = this.current(this.catalog[this.selected]?.id ?? -1);
    if (!r || !r.runs.length) return;
    const rect = this.fan.getBoundingClientRect();
    const { w, ht, L, R, T, B } = this.fanGeom();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const seconds = this.config.minutes * 60;
    const s = Math.round(((px - L) / (w - L - R)) * seconds);
    if (s < 0 || s > seconds) return this.setHover(-1);
    const y = (v: number) => T + (1 - (v - this.yLo) / (this.yHi - this.yLo)) * (ht - T - B);
    let best: BacktestRun | null = null, dist = 14;
    for (const run of r.runs) {
      const d = Math.abs(y(run.equity[Math.min(s, run.equity.length - 1)]) - py);
      if (d < dist) { dist = d; best = run; }
    }
    this.setHover(best ? best.seed : -1, best ? { x: px, y: py, run: best, s } : undefined);
  }

  private setHover(seed: number, at?: { x: number; y: number; run: BacktestRun; s: number }): void {
    if (at) {
      const { run, s } = at;
      const m = Math.floor(s / 60), sec = s % 60;
      this.fanTip.replaceChildren(
        h('b', `Session ${run.seed}`),
        h('span', `at ${m}:${String(sec).padStart(2, '0')}  ${dollars(run.equity[Math.min(s, run.equity.length - 1)])}`),
        h('span', `finished ${dollars(run.pnl)} · ${usd0.format(run.volume)} sh traded`),
        h('span.lab-tip-cta', 'Click to watch it trade'));
      this.fanTip.hidden = false;
      const wrap = this.fan.getBoundingClientRect();
      const tipW = 236;
      this.fanTip.style.left = `${Math.min(at.x + 14, wrap.width - tipW - 6)}px`;
      this.fanTip.style.top = `${Math.max(6, at.y - 58)}px`;
    } else {
      this.fanTip.hidden = true;
    }
    if (seed === this.hoverSeed) return;
    this.hoverSeed = seed;
    this.requestDraw();
  }

  private distLayout() {
    const r = this.current(this.catalog[this.selected]?.id ?? -1);
    const runs = r?.runs ?? [];
    const { w, h: ht } = fitCanvas(this.dist);
    const L = 14, R = 14, B = 22;
    if (!runs.length) return { runs, w, ht, dots: [] as { x: number; y: number; run: BacktestRun }[], x: (v: number) => v, L, R, B, rad: 4 };
    const pnls = runs.map((x) => x.pnl);
    let lo = Math.min(0, ...pnls), hi = Math.max(0, ...pnls);
    const pad = Math.max(10, (hi - lo) * 0.08);
    lo -= pad;
    hi += pad;
    const x = (v: number) => L + ((v - lo) / (hi - lo)) * (w - L - R);
    // Dot plot: bin by pixel column, stack upward.
    // Bins a few dots wide, so the shape of the distribution shows as stacks.
    const rad = runs.length > 60 ? 3 : 4;
    const binW = Math.max(rad * 2 + 2, Math.min(rad * 5, (w - L - R) / 24));
    const stacks = new Map<number, number>();
    const dots = [...runs].sort((a, b) => a.pnl - b.pnl).map((run) => {
      const bin = Math.round(x(run.pnl) / binW);
      const k = stacks.get(bin) ?? 0;
      stacks.set(bin, k + 1);
      return { x: bin * binW, y: ht - B - rad - 2 - k * (rad * 2 + 1), run };
    });
    return { runs, w, ht, dots, x, L, R, B, rad };
  }

  private drawDist(): void {
    const ctx = this.dist.getContext('2d')!;
    const { dpr } = fitCanvas(this.dist);
    const { runs, w, ht, dots, x, B, rad } = this.distLayout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);
    ctx.font = `10.5px ${cssVar('--mono')}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = cssVar('--faint');
    if (!runs.length) {
      ctx.fillText('One dot per session', w / 2, ht / 2);
      return;
    }
    const s = summarize(runs);
    ctx.strokeStyle = cssVar('--line-strong');
    ctx.beginPath();
    ctx.moveTo(0, ht - B + 0.5);
    ctx.lineTo(w, ht - B + 0.5);
    ctx.stroke();
    const tick = (v: number, label: string, color: string, top = 8) => {
      const xx = Math.round(x(v)) + 0.5;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(xx, top);
      ctx.lineTo(xx, ht - B + 4);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, Math.min(Math.max(xx, 22), w - 22), ht - B / 2 + 2);
    };
    tick(0, '$0', cssVar('--line-strong'));
    const maxStack = Math.min(...dots.map((d) => d.y));
    ctx.save();
    ctx.setLineDash([2, 3]);
    tick(s.mean, `mean ${dollars(s.mean)}`, cssVar('--amber'), Math.max(4, maxStack - 10));
    ctx.restore();
    const up = cssVar('--up'), down = cssVar('--down');
    for (const d of dots) {
      const hovered = d.run.seed === this.hoverSeed;
      ctx.fillStyle = hovered ? cssVar('--text') : d.run.pnl >= 0 ? up : down;
      ctx.globalAlpha = hovered || this.hoverSeed < 0 ? 0.9 : 0.35;
      ctx.beginPath();
      ctx.arc(d.x, d.y, hovered ? rad + 1 : rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private hoverDist(e: PointerEvent): void {
    const rect = this.dist.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const { dots, rad } = this.distLayout();
    let best = -1, dist = (rad + 3) ** 2;
    for (const d of dots) {
      const dd = (d.x - px) ** 2 + (d.y - py) ** 2;
      if (dd < dist) { dist = dd; best = d.run.seed; }
    }
    this.setHover(best);
  }

  private drawSparks(): void {
    this.catalog.forEach((st, i) => {
      const c = this.sparks[i];
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const { w, h: ht, dpr } = fitCanvas(c);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, ht);
      const r = this.current(st.id);
      if (!r || r.runs.length < 3) return;
      const n = r.runs[0].equity.length;
      const step = Math.max(1, Math.floor(n / w));
      const med: number[] = [];
      const col: number[] = [];
      for (let s = 0; s < n; s += step) {
        col.length = 0;
        for (const run of r.runs) col.push(run.equity[s]);
        col.sort((a, b) => a - b);
        med.push(percentile(col, 0.5));
      }
      const lo = Math.min(0, ...med), hi = Math.max(0, ...med);
      const yy = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (ht - 6);
      ctx.strokeStyle = cssVar('--line-strong');
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yy(0)) + 0.5);
      ctx.lineTo(w, Math.round(yy(0)) + 0.5);
      ctx.stroke();
      ctx.strokeStyle = med[med.length - 1] >= 0 ? cssVar('--up') : cssVar('--down');
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      med.forEach((v, k) => (k ? ctx.lineTo((k / (med.length - 1)) * w, yy(v)) : ctx.moveTo(0, yy(v))));
      ctx.stroke();
    });
  }

  // ------------------------------------------------------- open / close ----

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.el.hidden = false;
    document.documentElement.classList.add('lab-open');
    requestAnimationFrame(() => this.el.classList.add('in'));
    this.ensureWorker();
    if (location.hash !== '#lab') history.replaceState(null, '', '#lab');
    this.el.focus({ preventScroll: true });
    this.refreshAll();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.el.classList.remove('in');
    document.documentElement.classList.remove('lab-open');
    if (location.hash === '#lab') history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => { if (!this.opened) this.el.hidden = true; }, reduceMotion() ? 0 : 220);
    this.onClose();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  // -------------------------------------------------------------- watch ----

  /** The session whose P&L is the median of the current results, or -1. */
  private medianSeed(): number {
    const r = this.current(this.catalog[this.selected]?.id ?? -1);
    if (!r || !r.runs.length) return -1;
    const sorted = [...r.runs].sort((a, b) => a.pnl - b.pnl);
    return sorted[Math.floor((sorted.length - 1) / 2)].seed;
  }

  /** Hands one finished session to the terminal to play back, trade by trade. */
  private watchSeed(seed: number): void {
    if (seed < 0) return;
    const info = this.catalog[this.selected];
    const r = info && this.current(info.id);
    const run = r?.runs.find((x) => x.seed === seed);
    if (!info || !r || !run) return;
    const duration = r.config.minutes * 60;
    this.onWatch({
      seed: run.seed,
      warmup: WARMUP,
      length: duration * 1e6,
      actions: [],
      watch: {
        strategy: info.id,
        params: [...r.params],
        duration,
        scenario: r.config.scenario,
        scenarioAt: SCENARIO_AT,
        expect: run.pnl,
        label: `${info.name} · session ${run.seed}`,
      },
    });
  }
}

function strokePath(ctx: CanvasRenderingContext2D, eq: Float64Array, stride: number, x: (s: number) => number, y: (v: number) => number): void {
  ctx.beginPath();
  ctx.moveTo(x(0), y(eq[0]));
  for (let s = stride; s < eq.length; s += stride) ctx.lineTo(x(s), y(eq[s]));
  ctx.lineTo(x(eq.length - 1), y(eq[eq.length - 1]));
  ctx.stroke();
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
