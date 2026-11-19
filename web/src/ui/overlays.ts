// Things that float above the terminal: toasts, modals, the tour and the
// market-maker challenge.
import type { App } from '../app';
import { $, h, setText } from '../dom';
import { Engine } from '../engine';
import { money, qty, signed, tone } from '../fmt';

// --------------------------------------------------------------- toasts ----

export function mountToasts(app: App): void {
  const root = $('toasts');
  app.on('toast', ({ text, tone: t }: { text: string; tone: string }) => {
    const el = h(`div.toast.${t}`, text);
    root.append(el);
    while (root.childElementCount > 4) root.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4600);
  });
}

// ---------------------------------------------------------------- modal ----

interface ModalOptions {
  title: string;
  body: (Node | string)[];
  actions: { label: string; solid?: boolean; run?: () => void }[];
  wide?: boolean;
  onClose?: () => void;
}

export function openModal(opts: ModalOptions): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    previous?.focus?.();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const focusable = modal.querySelectorAll<HTMLElement>('button, a[href], input');
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const buttons = opts.actions.map((a) =>
    h(`button.btn${a.solid ? '.solid' : ''}`, { type: 'button', onclick: () => { close(); a.run?.(); } }, a.label));
  const modal = h(`div.modal${opts.wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div.modal-head', h('h3', opts.title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    h('div.modal-body', ...opts.body),
    h('div.modal-foot', ...buttons));
  const scrim = h('div.scrim', modal);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  $('modal-root').append(scrim);
  document.addEventListener('keydown', onKey);
  (buttons[buttons.length - 1] ?? modal).focus();
  return close;
}

const fact = (label: string, value: string, sub: string, cls = '') =>
  h('div.fact', h('span.label', label), h(`div.v${cls ? '.' + cls : ''}`, value), h('div.sub', sub));

// ---------------------------------------------------------------- about ----

export function openAbout(app: App): void {
  const w = app.warmup;
  const rate = w.messages / Math.max(0.001, w.ms / 1000);
  const wasm = performance.getEntriesByType('resource').find((r) => r.name.endsWith('.wasm')) as PerformanceResourceTiming | undefined;
  const size = wasm?.decodedBodySize ? `${(wasm.decodedBodySize / 1024).toFixed(0)} KB` : '81 KB';
  openModal({
    title: 'How Tickforge works',
    wide: true,
    body: [
      h('p', 'Nothing here is a recording or a random line. There is a real ', h('b', 'limit order book and matching engine'), ', written in C++ and compiled to WebAssembly, running in this tab. Sixty-odd simulated traders send it orders. Every candle on the chart is made of their trades, and yours.'),
      h('div.fact-grid',
        fact('Engine speed, measured here', `${(rate / 1e6).toFixed(1)}M msg/s`, `When this page loaded, it simulated ${Math.round(w.seconds / 60)} minutes of trading (${qty(w.messages)} orders, cancels and fills) in ${w.ms.toFixed(0)} ms.`),
        fact('Matching engine', size, 'The whole exchange: order book, matching, traders and analytics. No JavaScript glue code.'),
        fact('Native benchmark', '37M orders/s', '27 nanoseconds per order on a desktop CPU. Add, cancel and match are all constant time.'),
        fact('Correctness', '3.9M checks', 'The engine is fuzzed against a slow, obviously correct reference book. They must agree on every fill.')),
      h('ul',
        h('li', h('b', 'Price-time priority.'), ' Best price trades first. At the same price, whoever arrived first. Limit, market, IOC, FOK and post-only orders, with self-trade prevention.'),
        h('li', h('b', 'Prices emerge.'), ' No agent is told what the price should be. Market makers quote, retail flow pays the spread, value traders lean against mispricing, momentum traders chase, and informed traders pick off stale quotes.'),
        h('li', h('b', 'Deterministic.'), ' A market is a pure function of its seed and what you do. The same seed replays the same market, which is how the challenge compares you with a bot on equal terms.'),
        h('li', h('b', 'Honest accounting.'), ' Your P&L is split exactly into spread captured, inventory moves and fees. Markouts show whether the people trading with you knew more than you did.')),
      h('p', 'Built by Haneet Singh, Mechanical Engineering at the University of Waterloo. The source, the tests and a write-up of the design are on GitHub.'),
    ],
    actions: [
      { label: 'View the source', run: () => window.open(($('link-github') as HTMLAnchorElement).href, '_blank', 'noopener') },
      { label: 'Close', solid: true },
    ],
  });
}

// ----------------------------------------------------------------- tour ----

interface Step {
  target: string;
  title: string;
  text: string;
  before?: (app: App) => void;
}

const STEPS: Step[] = [
  { target: 'panel-chart', title: 'A market that is actually running', text: 'Each candle is built from real trades between simulated traders, matched by a C++ engine running in this tab. Scroll to zoom, drag to look back, and pick a candle interval at the top left.' },
  { target: 'panel-book', title: 'The order book', text: 'Everyone waiting to trade. Each row is one price and stays put while the market moves through it. Green bids want to buy, red offers want to sell, and the grey rows between them are the spread. Click any price to load it into the ticket.' },
  { target: 'panel-ticket', title: 'Trade against them', text: 'A market order trades now and pays the spread. A limit order names its price and waits in the queue. Before you send anything, the ticket shows what it will cost. Try a 5,000 share market order and watch it eat through the book.' },
  { target: 'panel-depth', title: 'Depth is what a big order costs', text: 'The curve shows how many shares sit between here and each price. Hover it to see how far a given size would push the price. Thin book, big impact.' },
  { target: 'btn-xray', title: 'X-ray', text: 'Things no real trader can see: the amber line on the chart is what the stock is truly worth, and the tape shows which kind of trader was behind each trade. Switch it off to trade blind like everyone else.', before: (app) => app.setXray(true) },
  { target: 'btn-scenarios', title: 'Break the market', text: 'Trigger a flash crash, a news shock or a liquidity drought and watch every type of trader react. The crash is modelled on May 6, 2010.' },
  { target: 'panel-dock', title: 'Your account, and a bot', text: 'Your P&L is split into where it came from: spread earned, inventory moves and fees. The market-making bot tab runs the Avellaneda-Stoikov model on your account, and "Who is trading" shows who is winning.' },
  { target: 'btn-challenge', title: 'Then try the challenge', text: 'Three minutes as the market maker. Quote both sides, earn the spread, and do not get caught holding inventory when the news hits. You are scored against a bot on the exact same market.' },
];

export class Tour {
  private i = 0;
  private ring = h('div.tour-ring');
  private card = h('div.tour-card', { role: 'dialog', 'aria-label': 'Tour' });
  private active = false;
  private onResize = () => this.place();
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.stop();
    if (e.key === 'ArrowRight' || e.key === 'Enter') this.go(1);
    if (e.key === 'ArrowLeft') this.go(-1);
  };

  constructor(private app: App) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.i = 0;
    document.body.append(this.ring, this.card);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKey, true);
    this.render();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.ring.remove();
    this.card.remove();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey, true);
    try { localStorage.setItem('tickforge.toured', '1'); } catch { /* private mode */ }
  }

  private go(d: number): void {
    const next = this.i + d;
    if (next >= STEPS.length) return this.stop();
    if (next < 0) return;
    this.i = next;
    this.render();
  }

  private render(): void {
    const step = STEPS[this.i];
    step.before?.(this.app);
    const lastStep = this.i === STEPS.length - 1;
    this.card.replaceChildren(
      h('h4', step.title),
      h('p', step.text),
      h('div.foot',
        h('span.steps', `${this.i + 1} / ${STEPS.length}`),
        h('div',
          h('button.btn.tiny', { type: 'button', onclick: () => this.stop() }, 'Skip'),
          this.i > 0 ? h('button.btn.tiny', { type: 'button', onclick: () => this.go(-1) }, 'Back') : null,
          h('button.btn.tiny.solid', { type: 'button', onclick: () => this.go(1) }, lastStep ? 'Start trading' : 'Next'))));
    $(step.target).scrollIntoView({ block: 'nearest' });
    this.place();
    (this.card.querySelector('.solid') as HTMLElement).focus();
  }

  private place(): void {
    const r = $(STEPS[this.i].target).getBoundingClientRect();
    const pad = 4;
    Object.assign(this.ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Prefer beside the target, then below, then above, then on top of it.
    let x: number, y: number;
    if (r.left - cw - 16 >= 8) { x = r.left - cw - 16; y = r.top; }
    else if (r.right + cw + 16 <= vw - 8) { x = r.right + 16; y = r.top; }
    else if (r.bottom + ch + 16 <= vh - 8) { x = r.left; y = r.bottom + 16; }
    else if (r.top - ch - 16 >= 8) { x = r.left; y = r.top - ch - 16; }
    else { x = r.left + 16; y = r.top + 16; }
    this.card.style.left = `${Math.max(8, Math.min(x, vw - cw - 8))}px`;
    this.card.style.top = `${Math.max(8, Math.min(y, vh - ch - 8))}px`;
  }
}

// ------------------------------------------------------------ challenge ----

const DURATION = 180;
const NEWS_AT = 75;
const WARMUP = 1200;

interface ChallengeHooks {
  armLadder(on: boolean): void;
  showAccount(): void;
}

export class Challenge {
  private hud = h('div.hud', { hidden: true });
  private timeEl = h('span');
  private pnlEl = h('span');
  private posEl = h('span');
  private upEl = h('span');
  private startTime = 0;
  private seed = 0;
  private newsDone = false;
  private newsSign = 1;
  private saved = { xray: true, speed: 4 };

  constructor(private app: App, private hooks: ChallengeHooks) {
    this.hud.append(
      h('div.title', h('span', 'Market-maker challenge'), this.timeEl),
      h('div.line', h('span.k', 'P&L'), this.pnlEl),
      h('div.line', h('span.k', 'Inventory'), this.posEl),
      h('div.line', h('span.k', 'Two-sided quotes'), this.upEl),
      h('button.btn.tiny', { type: 'button', onclick: () => this.finish(true) }, 'End now'));
    $('panel-chart').querySelector('.chart-wrap')!.append(this.hud);
  }

  intro(): void {
    if (this.app.challengeActive) return;
    let best = '';
    try { best = localStorage.getItem('tickforge.best') ?? ''; } catch { /* private mode */ }
    openModal({
      title: 'Market-maker challenge',
      body: [
        h('p', 'For three minutes ', h('b', 'you are the market maker'), '. Keep a bid and an offer in the book, earn the spread when both sides trade, and do not get stuck holding a position when the price runs.'),
        h('ul',
          h('li', h('b', 'Click to trade is armed.'), ' Click any price below the middle of the book to bid there, above it to offer there. Prices inside the spread work too, and get you to the front. Right-click a price to cancel your orders at it.'),
          h('li', h('b', 'You trade blind.'), ' X-ray is off. News will hit at some point, and the informed traders will know before you do.'),
          h('li', h('b', 'Quote both sides at least 60% of the time'), ' or it does not count as market making.'),
          h('li', h('b', 'At the bell your position is closed at market'), ', whatever that costs.')),
        h('p', 'A fresh market is generated for each attempt. Afterwards the Avellaneda-Stoikov bot plays the same market from the same seed, so you can see how you compare.', best ? ` Your best so far: ${best}.` : ''),
      ],
      actions: [{ label: 'Not now' }, { label: 'Start', solid: true, run: () => this.begin() }],
    });
  }

  private begin(): void {
    const app = this.app;
    this.saved = { xray: app.xray, speed: app.speed };
    this.seed = Math.floor(Math.random() * 900000) + 100000;
    app.dials = { activity: 1, liquidity: 1, volatility: 1, momentum: true, informed: true, breaker: false };
    app.emit('dials');
    app.restart(this.seed, WARMUP);
    app.challengeActive = true;
    app.setXray(false);
    app.setSpeed(1);
    this.newsDone = false;
    this.newsSign = this.seed % 2 === 0 ? 1 : -1;
    this.startTime = app.s.time;
    this.hooks.armLadder(true);
    this.hooks.showAccount();
    this.hud.hidden = false;
    document.documentElement.classList.add('challenge');
    ($('btn-xray') as HTMLButtonElement).disabled = true;
    app.toast('The bell has rung. Get a bid and an offer into the book.', 'warn');
  }

  /** Called every frame. */
  update(): void {
    const app = this.app;
    if (!app.challengeActive) return;
    const s = app.s;
    const t = s.time - this.startTime;
    if (!this.newsDone && t >= NEWS_AT) {
      this.newsDone = true;
      app.engine.news(0.012 * this.newsSign);
    }
    const left = Math.max(0, DURATION - t);
    setText(this.timeEl, `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    setText(this.pnlEl, money(s.pnl));
    this.pnlEl.className = tone(s.pnl, 0.5);
    setText(this.posEl, signed(s.position));
    this.posEl.className = tone(s.position);
    setText(this.upEl, `${(s.twoSided * 100).toFixed(0)}%`);
    this.upEl.className = s.twoSided >= 0.6 ? 'up' : 'down';
    if (left <= 0) this.finish(false);
  }

  private async finish(early: boolean): Promise<void> {
    const app = this.app;
    if (!app.challengeActive) return;
    app.challengeActive = false;
    const elapsed = app.s.time - this.startTime;
    app.engine.flatten();
    app.pull();
    const s = app.s;
    this.hud.hidden = true;
    this.hooks.armLadder(false);
    document.documentElement.classList.remove('challenge');
    ($('btn-xray') as HTMLButtonElement).disabled = false;
    app.setXray(this.saved.xray);
    app.paused = true;
    app.emit('speed');

    // The bot plays the same market: same seed, same warm-up, same news.
    const rival = await Engine.create(this.seed);
    rival.step(WARMUP);
    rival.bot(true, { gamma: 0.05, kappa: 0.7, horizon: 10, size: 100, maxInventory: 1000 });
    if (elapsed > NEWS_AT) {
      rival.step(NEWS_AT);
      rival.news(0.012 * this.newsSign);
      rival.step(elapsed - NEWS_AT);
    } else {
      rival.step(elapsed);
    }
    rival.bot(false, { gamma: 0.05, kappa: 0.7, horizon: 10, size: 100, maxInventory: 1000 });
    rival.flatten();
    const bot = rival.state();

    const qualified = s.twoSided >= 0.6 && !early && s.userTrades > 0;
    const you = s.pnl, them = bot.pnl;
    let grade = 'D';
    if (!qualified) grade = '—';
    else if (you > 0 && you >= them) grade = 'S';
    else if (you > 0) grade = 'A';
    else if (you > -2500) grade = 'B';
    else if (you > -10000) grade = 'C';
    const verdict = !qualified
      ? early ? 'Ended early, so this one is not graded.' : s.userTrades === 0 ? 'You never traded. A market maker has to be in the book.' : 'You quoted both sides less than 60% of the time, so this one is not graded.'
      : you >= them && you > 0 ? 'You beat the bot on the same market.'
      : you > 0 ? 'Profitable, but the bot did better on the same market.'
      : 'The market took money off you this time. Look at where it went below.';
    if (qualified) {
      try {
        const prev = Number(localStorage.getItem('tickforge.bestTicks') ?? '-1e18');
        if (you > prev) {
          localStorage.setItem('tickforge.bestTicks', String(you));
          localStorage.setItem('tickforge.best', `${money(you)} (grade ${grade})`);
        }
      } catch { /* private mode */ }
    }

    openModal({
      title: 'Closing bell',
      wide: true,
      body: [
        h('div', { style: 'display:flex;gap:18px;align-items:center' },
          h(`div.grade.${grade === 'S' || grade === 'A' ? 'up' : grade === 'B' ? 'amber' : grade === '—' ? 'dim' : 'down'}`, grade),
          h('p', h('b', verdict), ` The news at ${Math.floor(NEWS_AT / 60)}:${String(NEWS_AT % 60).padStart(2, '0')} was ${this.newsSign > 0 ? 'good: fair value jumped 1.2%' : 'bad: fair value dropped 1.2%'}.`)),
        h('div.versus',
          fact('You', money(you), `${qty(s.userTrades)} fills, ${qty(s.userVolume)} shares`, tone(you, 0.5)),
          fact('Avellaneda-Stoikov bot, same seed', money(them), `${qty(bot.userTrades)} fills, ${qty(bot.userVolume)} shares`, tone(them, 0.5))),
        h('div.score-grid',
          fact('Spread captured', money(s.pnlSpread), 'Earned from buying below mid and selling above it.', tone(s.pnlSpread, 0.5)),
          fact('Inventory', money(s.pnlInventory), 'What your position did while you held it.', tone(s.pnlInventory, 0.5)),
          fact('Fees', money(-s.fees), 'Rebates earned less fees paid.', tone(-s.fees, 0.5)),
          fact('Largest position', `${qty(Math.max(s.maxLong, -s.maxShort))}`, 'Shares, long or short.'),
          fact('Two-sided', `${(s.twoSided * 100).toFixed(0)}%`, 'Time with both a bid and an offer resting.', s.twoSided >= 0.6 ? 'up' : 'down'),
          fact('Markout, 5s', `${signed(s.markout5, 2)} tk`, 'Negative means the people who traded with you knew something.', tone(s.markout5, 0.005))),
        h('p', `Seed ${this.seed}. The market is paused so you can look at what happened. Press play to carry on trading it.`),
      ],
      actions: [
        { label: 'Back to the market', run: () => { app.setSpeed(this.saved.speed); } },
        { label: 'Try again', solid: true, run: () => this.begin() },
      ],
    });
  }
}
