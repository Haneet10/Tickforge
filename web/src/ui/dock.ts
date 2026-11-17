// The tabbed dock under the chart: account, orders, the market-making bot,
// who is trading, and the controls that change the market itself.
import { SCENARIOS, type App } from '../app';
import { $, clamp, cssVar, fitCanvas, h, setText } from '../dom';
import { Engine, KINDS, Side, type Fill } from '../engine';
import { clock, compact, money, px, qty, signed, tone } from '../fmt';

type TabId = 'account' | 'orders' | 'bot' | 'who' | 'market';

const KIND_COLORS = ['#ffb224', '#8a929d', '#4cc3ff', '#ff8a4c', '#12d989', '#b39bff', '#ff4057'];
const KIND_BLURBS = [
  'Your account.',
  'Uninformed orders with no view on value. They pay the spread and fund everyone else.',
  'Quote both sides and earn the spread. They lose when someone better informed trades with them.',
  'Buy what is rising and sell what is falling. They make moves overshoot.',
  'Have a noisy estimate of fair value and lean against mispricings.',
  'Know fair value exactly and act first. The reason quoting is risky.',
  'Large orders worked over time. Only active in scenarios.',
];

interface Pane {
  el: HTMLElement;
  update(): void;
}

export class Dock {
  private body = $('dock-body');
  private panes = new Map<TabId, Pane>();
  active: TabId = 'account';
  private avgCost = 0;
  private trackedPos = 0;

  constructor(private app: App) {
    this.panes.set('account', this.accountPane());
    this.panes.set('orders', this.ordersPane());
    this.panes.set('bot', this.botPane());
    this.panes.set('who', this.whoPane());
    this.panes.set('market', this.marketPane());
    for (const [id, p] of this.panes) {
      p.el.classList.add('tab-pane');
      p.el.hidden = id !== this.active;
      this.body.append(p.el);
    }
    for (const tab of document.querySelectorAll<HTMLElement>('#dock-tabs .tab'))
      tab.addEventListener('click', () => this.show(tab.dataset.tab as TabId));

    app.on('fills', (fresh: Fill[]) => {
      for (const f of fresh) this.trackCost(f);
    });
    const resetCost = () => {
      this.avgCost = 0;
      this.trackedPos = 0;
    };
    app.on('restart', resetCost);
    app.on('account-reset', resetCost);
  }

  show(id: TabId): void {
    this.active = id;
    for (const [pid, p] of this.panes) p.el.hidden = pid !== id;
    for (const tab of document.querySelectorAll<HTMLElement>('#dock-tabs .tab'))
      tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
    this.update();
  }

  update(): void {
    this.panes.get(this.active)!.update();
    const n = this.app.orders.length;
    setText($('tab-orders-n'), n ? String(n) : '');
  }

  /** Average cost of the open position, maintained from the fill stream. */
  private trackCost(f: Fill): void {
    const dir = f.side === Side.Buy ? 1 : -1;
    const pos = this.trackedPos;
    const next = pos + dir * f.qty;
    if (pos === 0 || Math.sign(pos) === dir) {
      this.avgCost = (this.avgCost * Math.abs(pos) + f.price * f.qty) / Math.abs(next);
    } else if (Math.sign(next) !== Math.sign(pos) && next !== 0) {
      this.avgCost = f.price; // flipped through zero
    } else if (next === 0) {
      this.avgCost = 0;
    }
    this.trackedPos = next;
  }

  // ------------------------------------------------------------ account ----

  private accountPane(): Pane {
    const app = this.app;
    const pos = h('div.v.big'), posSub = h('div.sub');
    const pnl = h('div.v.big'), pnlSub = h('div.sub');
    const names = ['Spread captured', 'Inventory', 'Fees and rebates'];
    const tips = [
      'What you earned by buying below the mid price and selling above it, measured at the moment of each fill.',
      'What your position gained or lost as the price moved after you traded.',
      'Takers pay the exchange $0.003 a share. Makers are paid $0.002.',
    ];
    const bars = names.map((name, i) => {
      const fill = h('i'), num = h('span.num');
      return { fill, num, row: h('div.split-row', { title: tips[i] }, h('span.name', name), h('div.track', fill), num) };
    });
    const mk = (label: string, title: string) => {
      const v = h('div.v');
      return { v, el: h('div.kv', { title }, h('span.label', label), v) };
    };
    const m1 = mk('Markout 1s', 'Where the mid went one second after your fills, per share. Negative means you were picked off.');
    const m5 = mk('Markout 5s', 'The same, five seconds after.');
    const m30 = mk('Markout 30s', 'The same, thirty seconds after.');
    const dd = mk('Max drawdown', 'Largest fall in P&L from its peak.');
    const vol = mk('Volume', 'Shares you have traded.');
    const mkr = mk('Passive', 'Share of your volume that was resting on the book when it traded.');
    const spark = h('canvas');
    const sparkLabel = h('span.label', 'P&L this session');

    const el = h('div.account',
      h('div',
        h('div.kv', h('span.label', 'Position'), pos, posSub),
        h('div.kv', h('span.label', 'Profit and loss'), pnl, pnlSub),
        h('div.actions',
          h('button.btn.tiny', { type: 'button', title: 'Cancel everything and close the position at market (F)', onclick: () => app.flatten() }, 'Flatten'),
          h('button.btn.tiny', { type: 'button', title: 'Cancel all resting orders (C)', onclick: () => app.cancelAll() }, 'Cancel all'),
          h('button.btn.tiny', { type: 'button', title: 'Start again from zero. The market keeps running.', onclick: () => app.resetAccount() }, 'Reset'))),
      h('div.split',
        h('span.label', 'Where the P&L came from'),
        ...bars.map((b) => b.row),
        h('div.mini-grid', m1.el, m5.el, m30.el, dd.el, vol.el, mkr.el)),
      h('div.spark', sparkLabel, spark));

    const ctx = spark.getContext('2d')!;
    const colUp = cssVar('--up'), colDown = cssVar('--down'), colLine = cssVar('--line-strong');

    const drawSpark = () => {
      const { w, h: ht, dpr } = fitCanvas(spark);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, ht);
      const hist = app.history;
      const from = Math.floor(app.sessionStart);
      const n = hist.n - from + 1;
      if (n < 2) return;
      const stride = Math.max(1, Math.floor(n / w));
      let lo = 0, hi = 0;
      for (let i = from; i <= hist.n; i += stride) {
        lo = Math.min(lo, hist.pnl[i]);
        hi = Math.max(hi, hist.pnl[i]);
      }
      if (hi - lo < 100) { hi += 50; lo -= 50; }
      const yOf = (v: number) => 3 + (1 - (v - lo) / (hi - lo)) * (ht - 6);
      const zero = Math.round(yOf(0)) + 0.5;
      ctx.strokeStyle = colLine;
      ctx.beginPath();
      ctx.moveTo(0, zero);
      ctx.lineTo(w, zero);
      ctx.stroke();
      const last = hist.pnl[hist.n];
      ctx.strokeStyle = last >= 0 ? colUp : colDown;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = from, k = 0; i <= hist.n; i += stride, k++) {
        const x = ((i - from) / Math.max(1, n - 1)) * w;
        if (k === 0) ctx.moveTo(x, yOf(hist.pnl[i])); else ctx.lineTo(x, yOf(hist.pnl[i]));
      }
      ctx.lineTo(w, yOf(last));
      ctx.stroke();
      ctx.lineTo(w, zero);
      ctx.lineTo(0, zero);
      ctx.closePath();
      ctx.fillStyle = (last >= 0 ? colUp : colDown) + '1c';
      ctx.fill();
      ctx.lineWidth = 1;
    };

    return {
      el,
      update: () => {
        const s = app.s;
        setText(pos, s.position === 0 ? 'Flat' : `${signed(s.position)}`);
        pos.className = `v big ${tone(s.position)}`;
        const unreal = s.position !== 0 && this.avgCost > 0 ? (s.mid - this.avgCost) * s.position : 0;
        setText(posSub, s.position === 0 ? 'No open position' : `avg ${px(this.avgCost)} · open ${money(unreal)}`);
        setText(pnl, money(s.pnl));
        pnl.className = `v big ${tone(s.pnl, 0.5)}`;
        setText(pnlSub, s.userTrades ? `${qty(s.userTrades)} fills · marked to mid` : 'Place an order to begin');
        const parts = [s.pnlSpread, s.pnlInventory, -s.fees];
        const scale = Math.max(100, ...parts.map(Math.abs));
        parts.forEach((v, i) => {
          const b = bars[i];
          const wd = (Math.abs(v) / scale) * 50;
          b.fill.style.width = `${wd.toFixed(1)}%`;
          b.fill.style.left = v >= 0 ? '50%' : `${(50 - wd).toFixed(1)}%`;
          b.fill.style.background = v >= 0 ? colUp : colDown;
          setText(b.num, money(v));
          b.num.className = `num ${tone(v, 0.5)}`;
        });
        const mo = (el: HTMLElement, v: number) => {
          setText(el, s.userTrades ? `${signed(v, 2)} tk` : '—');
          el.className = `v ${s.userTrades ? tone(v, 0.005) : 'dim'}`;
        };
        mo(m1.v, s.markout1);
        mo(m5.v, s.markout5);
        mo(m30.v, s.markout30);
        setText(dd.v, money(-s.maxDrawdown, false).replace('−', ''));
        setText(vol.v, compact(s.userVolume));
        setText(mkr.v, s.userVolume ? `${((s.userMakerVolume / s.userVolume) * 100).toFixed(0)}%` : '—');
        drawSpark();
      },
    };
  }

  // ------------------------------------------------------------- orders ----

  private ordersPane(): Pane {
    const app = this.app;
    const open = h('tbody'), fills = h('tbody');
    const openEmpty = h('div.empty.hint', 'No resting orders. A limit order that does not trade straight away waits here, in a queue behind everyone who got to that price first.');
    const fillsEmpty = h('div.empty.hint', 'No fills yet.');
    const openTbl = h('table.tbl', h('thead', h('tr', h('th', 'Side'), h('th', 'Price'), h('th', 'Left'), h('th', { title: 'Shares ahead of you in the queue at this price' }, 'Queue ahead'), h('th', ''))), open);
    const fillsTbl = h('table.tbl', h('thead', h('tr', h('th', 'Time'), h('th', 'Side'), h('th', 'Price'), h('th', 'Size'), h('th', ''), h('th', { title: 'Your price compared with the mid when you traded, in ticks per share' }, 'Edge'))), fills);
    const el = h('div.orders-split', h('div', openTbl, openEmpty), h('div', fillsTbl, fillsEmpty));
    let openKey = '', fillKey = -1;

    open.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (btn) app.cancel(Number(btn.dataset.id));
    });

    return {
      el,
      update: () => {
        const key = app.orders.map((o) => `${o.id}:${o.remaining}:${o.queueAhead}`).join('|');
        if (key !== openKey) {
          openKey = key;
          open.replaceChildren(...app.orders.map((o) =>
            h('tr',
              h(`td.${o.side === Side.Buy ? 'up' : 'down'}`, o.side === Side.Buy ? 'BUY' : 'SELL'),
              h('td', px(o.price)),
              h('td', o.remaining === o.original ? qty(o.remaining) : `${qty(o.remaining)} / ${qty(o.original)}`),
              h('td', o.queueAhead ? qty(o.queueAhead) : 'first in line'),
              h('td', h('button.x-btn', { type: 'button', 'data-id': o.id, 'aria-label': 'Cancel order' }, '✕')))));
          openTbl.hidden = app.orders.length === 0;
          openEmpty.hidden = app.orders.length > 0;
        }
        if (app.fills.length !== fillKey) {
          fillKey = app.fills.length;
          const recent = app.fills.slice(-60).reverse();
          fills.replaceChildren(...recent.map((f) => {
            const edge = (f.side === Side.Buy ? f.mid - f.price : f.price - f.mid);
            return h('tr',
              h('td.dim', clock(f.time)),
              h(`td.${f.side === Side.Buy ? 'up' : 'down'}`, f.side === Side.Buy ? 'BUY' : 'SELL'),
              h('td', px(f.price)),
              h('td', qty(f.qty)),
              h('td', h('span.tag', { title: f.maker ? 'Your resting order was hit: you provided liquidity' : 'You crossed the spread: you took liquidity' }, f.maker ? 'MAKER' : 'TAKER')),
              h(`td.${tone(edge)}`, signed(edge, 1)));
          }));
          fillsTbl.hidden = recent.length === 0;
          fillsEmpty.hidden = recent.length > 0;
        }
      },
    };
  }

  // ---------------------------------------------------------------- bot ----

  private botPane(): Pane {
    const app = this.app;
    const toggle = h('input', { type: 'checkbox' });
    toggle.addEventListener('change', () => {
      if (app.challengeActive) { toggle.checked = false; app.toast('The bot is locked during the challenge. This one is on you.', 'warn'); return; }
      app.setBot(toggle.checked);
    });

    const slider = (label: string, title: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, log = false) => {
      const val = h('span.val');
      const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)) * 1000;
      const fromPos = (p: number) => (log ? min * Math.pow(max / min, p / 1000) : min + (p / 1000) * (max - min));
      const input = h('input', { type: 'range', min: '0', max: '1000', step: '1', 'aria-label': label });
      input.value = String(toPos(get()));
      val.textContent = fmt(get());
      input.addEventListener('input', () => {
        let v = fromPos(Number(input.value));
        v = log ? Number(v.toPrecision(2)) : Math.round(v / step) * step;
        set(v);
        val.textContent = fmt(v);
        app.updateBot();
      });
      return h('div.slider', { title }, h('div.slider-head', h('span.label', label), val), input);
    };

    const res = h('div.v'), half = h('div.v'), quotes = h('div.v'), inv = h('div.v');
    const studyCanvas = h('canvas');
    const studyBtn = h('button.btn.tiny', { type: 'button' }, 'Run study');
    const studyNote = h('span.hint', 'Runs the bot through 12 different markets at each of 7 risk settings, off screen, and plots what it earned against how much that varied.');
    let study: { gamma: number; mean: number; sd: number }[] = [];
    let running = false;

    studyBtn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      studyBtn.disabled = true;
      study = [];
      const gammas = [0.005, 0.012, 0.03, 0.07, 0.15, 0.3, 0.6];
      const seeds = 12;
      const lab = await Engine.create(1);
      const t0 = performance.now();
      let done = 0;
      for (const gamma of gammas) {
        const pnls: number[] = [];
        for (let k = 0; k < seeds; k++) {
          lab.reset(1000 + k);
          lab.step(300);
          lab.bot(true, { ...app.bot, gamma });
          lab.step(600);
          pnls.push(lab.state().pnl / 100);
          done++;
          if (done % 4 === 0) {
            setText(studyBtn, `${Math.round((done / (gammas.length * seeds)) * 100)}%`);
            await new Promise((r) => setTimeout(r));
          }
        }
        const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1));
        study.push({ gamma, mean, sd });
        drawStudy();
      }
      const secs = (performance.now() - t0) / 1000;
      setText(studyNote, `${gammas.length * seeds} ten-minute sessions simulated in ${secs.toFixed(1)}s. Up is more profit, right is more risk. Low risk aversion earns more on average but swings harder.`);
      setText(studyBtn, 'Run again');
      studyBtn.disabled = false;
      running = false;
    });

    const sctx = studyCanvas.getContext('2d')!;
    const drawStudy = () => {
      const { w, h: ht, dpr } = fitCanvas(studyCanvas);
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, w, ht);
      sctx.font = `10.5px 'IBM Plex Mono', monospace`;
      sctx.textBaseline = 'middle';
      const L = 46, B = 18, T = 8, R = 44;
      sctx.strokeStyle = cssVar('--line-strong');
      sctx.beginPath();
      sctx.moveTo(L + 0.5, T);
      sctx.lineTo(L + 0.5, ht - B + 0.5);
      sctx.lineTo(w - 4, ht - B + 0.5);
      sctx.stroke();
      sctx.fillStyle = cssVar('--faint');
      if (!study.length) {
        sctx.textAlign = 'center';
        sctx.fillText('mean P&L  vs  risk (stdev of P&L)', (L + w) / 2, (ht - B) / 2);
        return;
      }
      const maxSd = Math.max(...study.map((p) => p.sd)) * 1.15;
      const lo = Math.min(0, ...study.map((p) => p.mean)), hi = Math.max(1, ...study.map((p) => p.mean));
      const padY = (hi - lo) * 0.15;
      const xOf = (v: number) => L + (v / maxSd) * (w - L - R);
      const yOf = (v: number) => T + (1 - (v - (lo - padY)) / (hi - lo + 2 * padY)) * (ht - B - T);
      sctx.textAlign = 'right';
      sctx.fillText(`$${hi.toFixed(0)}`, L - 5, yOf(hi));
      sctx.fillText('$0', L - 5, yOf(0));
      if (lo < -1) sctx.fillText(`−$${Math.abs(lo).toFixed(0)}`, L - 5, yOf(lo));
      sctx.textAlign = 'center';
      sctx.fillText(`risk: stdev of P&L, up to $${maxSd.toFixed(0)}`, (L + w - R) / 2, ht - B / 2 + 1);
      sctx.strokeStyle = cssVar('--line');
      sctx.beginPath();
      sctx.moveTo(L, Math.round(yOf(0)) + 0.5);
      sctx.lineTo(w - 4, Math.round(yOf(0)) + 0.5);
      sctx.stroke();
      sctx.strokeStyle = cssVar('--violet');
      sctx.beginPath();
      study.forEach((p, i) => (i ? sctx.lineTo(xOf(p.sd), yOf(p.mean)) : sctx.moveTo(xOf(p.sd), yOf(p.mean))));
      sctx.stroke();
      sctx.textAlign = 'left';
      for (const p of study) {
        sctx.fillStyle = cssVar('--violet');
        sctx.beginPath();
        sctx.arc(xOf(p.sd), yOf(p.mean), 3, 0, Math.PI * 2);
        sctx.fill();
      }
      // Labels: try four spots around each point and skip any that would overlap.
      const placed: number[][] = [];
      sctx.fillStyle = cssVar('--dim');
      for (const p of study) {
        const text = `γ ${p.gamma}`;
        const tw = sctx.measureText(text).width;
        const x = xOf(p.sd), y = yOf(p.mean);
        for (const [dx, dy] of [[6, -8], [6, 9], [-6 - tw, -8], [-6 - tw, 9]]) {
          const box = [x + dx, y + dy - 6, x + dx + tw, y + dy + 6];
          if (box[0] < L || box[2] > w || box[1] < 0 || box[3] > ht - B) continue;
          if (placed.some((b) => box[0] < b[2] + 3 && box[2] > b[0] - 3 && box[1] < b[3] && box[3] > b[1])) continue;
          placed.push(box);
          sctx.fillText(text, x + dx, y + dy);
          break;
        }
      }
    };

    const el = h('div.bot',
      h('div',
        h('label.switch', toggle, h('span.track'), h('span.name', 'Quote for me')),
        slider('Risk aversion γ', 'How much the bot dislikes holding inventory. Higher means wider quotes and a harder lean against its position.', 0.005, 0.6, 0, () => app.bot.gamma, (v) => (app.bot.gamma = v), (v) => String(v), true),
        slider('Quote size', 'Shares on each side.', 10, 500, 10, () => app.bot.size, (v) => (app.bot.size = v), (v) => `${qty(v)} sh`),
        slider('Inventory limit', 'Stop quoting the side that would take the position past this.', 100, 5000, 100, () => app.bot.maxInventory, (v) => (app.bot.maxInventory = v), (v) => `±${qty(v)}`),
        slider('Horizon T', 'How far ahead the bot worries about price risk, in seconds.', 2, 60, 1, () => app.bot.horizon, (v) => (app.bot.horizon = v), (v) => `${v}s`)),
      h('div', { style: 'display:grid;gap:9px;align-content:start' },
        h('div.formula', { title: 'Avellaneda and Stoikov, High-frequency trading in a limit order book (2008)' },
          h('div', 'r = mid − q·γ·σ²·T'),
          h('div', 'δ = γσ²T/2 + ln(1+γ/κ)/γ')),
        h('div.readout',
          h('div.kv', h('span.label', 'Reservation price'), res),
          h('div.kv', h('span.label', 'Half spread'), half),
          h('div.kv', h('span.label', 'Quoting'), quotes),
          h('div.kv', h('span.label', 'Inventory q'), inv)),
        h('p.hint', { style: 'margin:0' }, 'This is the Avellaneda-Stoikov market-making model. It quotes around a ', h('b', 'reservation price'), ' that shifts away from the mid as inventory builds, so it sells more eagerly when long and buys more eagerly when short. Its quotes show on the chart as dotted violet lines.')),
      h('div.study-col',
        h('div.study',
          h('div.study-head', h('span.label', 'Risk study'), studyBtn),
          studyCanvas, studyNote)));

    app.on('bot', () => (toggle.checked = app.bot.enabled));
    app.on('restart', () => (toggle.checked = false));

    return {
      el,
      update: () => {
        const s = app.s;
        if (s.botEnabled) {
          setText(res, px(s.botReservation));
          setText(half, `${s.botHalfSpread.toFixed(2)} ticks`);
          setText(quotes, `${s.botBid ? px(s.botBid) : '—'} / ${s.botAsk ? px(s.botAsk) : '—'}`);
        } else {
          for (const e of [res, half, quotes]) setText(e, '—');
        }
        setText(inv, `${signed(s.position / app.bot.size, 1)} clips`);
        inv.className = `v ${tone(s.position)}`;
        if (!running) drawStudy();
      },
    };
  }

  // ---------------------------------------------------------------- who ----

  private whoPane(): Pane {
    const app = this.app;
    const tbody = h('tbody');
    const locked = h('div.empty.hint', 'Turn on X-ray to see who is behind the trades. A real trader never gets to see this.');
    const tbl = h('table.tbl',
      h('thead', h('tr', h('th', 'Trader type'), h('th', 'Traders'), h('th', 'Position'), h('th', 'P&L'), h('th', { title: 'Share of all volume traded' }, 'Volume'), h('th', { title: 'Share of their volume that was passive' }, 'Passive'))),
      tbody);
    const rows = KINDS.map((name, k) => {
      const cells = [h('td'), h('td'), h('td'), h('td'), h('td')];
      const bar = h('i.pnl-bar');
      const pnlText = h('span');
      cells[2].append(bar, pnlText);
      const tr = h('tr', { title: KIND_BLURBS[k] }, h('td', h('i.kdot', { style: `background:${KIND_COLORS[k]}` }), name), ...cells);
      tbody.append(tr);
      return { cells, bar, pnlText };
    });
    const el = h('div.who-pane',
      h('div', tbl, locked),
      h('div',
        h('p.hint', { style: 'margin:0 0 8px' }, h('b', 'Trading is zero-sum before fees.'), ' Every dollar one group makes, another loses. Uninformed flow pays the spread, market makers collect it, and informed traders take it back from the market makers.'),
        h('p.hint', { style: 'margin:0' }, 'Hover a row to see how that type of trader behaves. Trigger a flash crash and watch the P&L move between them.')));
    let last = 0;
    return {
      el,
      update: () => {
        tbl.hidden = !app.xray;
        locked.hidden = app.xray;
        if (!app.xray) return;
        const now = performance.now();
        if (now - last < 400) return;
        last = now;
        const kinds = app.kinds();
        const total = Math.max(1, kinds.reduce((a, k) => a + k.volume, 0));
        const maxPnl = Math.max(100, ...kinds.map((k) => Math.abs(k.pnl)));
        kinds.forEach((k, i) => {
          const r = rows[i];
          setText(r.cells[0], qty(k.traders));
          setText(r.cells[1], signed(k.position));
          r.cells[1].className = tone(k.position);
          r.bar.style.width = `${((Math.abs(k.pnl) / maxPnl) * 46).toFixed(0)}px`;
          r.bar.style.background = k.pnl >= 0 ? 'var(--up)' : 'var(--down)';
          setText(r.pnlText, money(k.pnl));
          r.cells[2].className = tone(k.pnl, 0.5);
          setText(r.cells[3], `${((k.volume / total) * 100).toFixed(0)}%`);
          setText(r.cells[4], k.volume ? `${((k.makerVolume / k.volume) * 100).toFixed(0)}%` : '—');
        });
      },
    };
  }

  // ------------------------------------------------------------- market ----

  private marketPane(): Pane {
    const app = this.app;
    const dial = (label: string, title: string, key: 'activity' | 'liquidity' | 'volatility') => {
      const val = h('span.val', `${app.dials[key].toFixed(1)}×`);
      const input = h('input', { type: 'range', min: '0.2', max: '3', step: '0.1', value: String(app.dials[key]), 'aria-label': label });
      input.addEventListener('input', () => {
        if (app.challengeActive) { input.value = String(app.dials[key]); return; }
        app.dials[key] = Number(input.value);
        val.textContent = `${app.dials[key].toFixed(1)}×`;
        app.applyDials();
      });
      app.on('dials', () => { input.value = String(app.dials[key]); val.textContent = `${app.dials[key].toFixed(1)}×`; });
      return h('div.slider', { title }, h('div.slider-head', h('span.label', label), val), input);
    };
    const sw = (label: string, title: string, key: 'momentum' | 'informed' | 'breaker') => {
      const input = h('input', { type: 'checkbox' });
      input.checked = app.dials[key];
      input.addEventListener('change', () => {
        if (app.challengeActive) { input.checked = app.dials[key]; return; }
        app.dials[key] = input.checked;
        app.applyDials();
      });
      app.on('dials', () => (input.checked = app.dials[key]));
      return h('label.switch.small', { title }, input, h('span.track'), h('span.name', label));
    };
    const seedIn = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Market seed' });
    const scenBtns = SCENARIOS.map((sc) =>
      h(`button.scen.${sc.tone}`, { type: 'button', onclick: () => app.runScenario(sc.id) }, h('span.name', sc.name), h('span.blurb', sc.blurb)));
    const el = h('div.market',
      h('div',
        dial('Retail activity', 'How much uninformed order flow arrives.', 'activity'),
        dial('Liquidity', 'How much size market makers show, and how many of them are quoting.', 'liquidity'),
        dial('Volatility', 'How fast the true value moves.', 'volatility'),
        sw('Momentum traders', 'Trend followers that pile into moves.', 'momentum'),
        sw('Informed traders', 'Traders who know the true value. Switch them off and quoting becomes easy money.', 'informed'),
        sw('Circuit breaker', 'Halt trading for 30 seconds if the price moves more than 3.5% from its two-minute average, like the limit-up/limit-down rule real exchanges adopted after 2010.', 'breaker'),
        h('div.row-2',
          h('div.input', { title: 'The same seed always produces the same market.' }, seedIn, h('span.unit', 'SEED')),
          h('button.btn.tiny', { type: 'button', style: 'height:30px', onclick: () => {
            if (app.challengeActive) return;
            const seed = clamp(Math.floor(Number(seedIn.value)) || Math.floor(Math.random() * 99999) + 1, 1, 2 ** 31);
            app.restart(seed);
            app.toast(`New market from seed ${seed}`, 'info');
          } }, 'New market'))),
      h('div', h('div.scen-grid', ...scenBtns)));
    return {
      el,
      update: () => {
        if (document.activeElement !== seedIn && seedIn.value === '') seedIn.placeholder = String(app.engine.seed);
        for (const b of scenBtns) b.disabled = app.challengeActive;
      },
    };
  }
}
