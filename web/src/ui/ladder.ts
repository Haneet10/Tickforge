// Order book ladder on a fixed price grid.
//
// Every row is one price tick and keeps its price while the market moves
// through it, the way a trading desk's price ladder works. Only the sizes in
// the rows change, so the eye can rest on a level and watch it fill or drain.
// The grid re-centres only when the price drifts near an edge.
import type { App } from '../app';
import { $, h, setText } from '../dom';
import { Side, type Level } from '../engine';
import { compact, px, qty } from '../fmt';
import { TrendTone } from './motion';

const ROW_H = 19;

interface Row {
  el: HTMLElement;
  p: HTMLElement;
  q: HTMLElement;
  t: HTMLElement;
  bar: HTMLElement;
  price: number;
  cls: string;
  scale: number;
  title: string;
}

interface Cell { qty: number; cum: number; mine: number; orders: number }

export class Ladder {
  private book = $('book');
  private rowsEl = $('book-rows');
  private midEl = $('book-mid');
  private rows: Row[] = [];
  private center = 0;
  private barMax = 1;
  private lastEl = h('span.last');
  private metaEl = h('span.meta');
  private imbEl = h('i');
  private tone = new TrendTone(3);
  armed = false;

  constructor(private app: App, private ticketQty: () => number) {
    this.midEl.append(this.lastEl, h('span.imb', { title: 'Share of resting size on the bid across the top five levels' }, this.imbEl), this.metaEl);
    const armBox = $<HTMLInputElement>('click-trade');
    armBox.addEventListener('change', () => this.setArmed(armBox.checked));
    new ResizeObserver(() => this.layout()).observe(this.book);
    app.on('restart', () => { this.center = 0; this.tone.reset(); });
    this.layout();
  }

  setArmed(on: boolean): void {
    this.armed = on;
    $<HTMLInputElement>('click-trade').checked = on;
    this.book.classList.toggle('armed', on);
  }

  /** Which side a click at this price trades: below the middle bids, above it offers. */
  private sideAt(price: number): Side | null {
    const { bid, ask } = this.app.s;
    const mid = bid && ask ? (bid + ask) / 2 : this.app.s.last;
    if (price < mid) return Side.Buy;
    if (price > mid) return Side.Sell;
    return null;
  }

  private makeRow(): Row {
    const p = h('span.p'), q = h('span.q'), t = h('span.t'), bar = h('i.bar');
    const el = h('div.row', bar, p, q, t);
    const row: Row = { el, p, q, t, bar, price: 0, cls: '', scale: 0, title: '' };
    el.addEventListener('click', () => {
      if (!row.price) return;
      const side = this.sideAt(row.price);
      if (side === null) return this.app.toast('That is exactly the middle of the spread. Pick a price just above or below it.', 'warn');
      if (this.armed) this.app.limit(side, row.price, this.ticketQty());
      else this.app.emit('pick-price', { price: row.price, side });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      for (const o of this.app.orders) if (o.price === row.price) this.app.cancel(o.id);
    });
    return row;
  }

  private layout(): void {
    const n = Math.max(5, Math.floor(this.book.clientHeight / ROW_H));
    while (this.rows.length < n) {
      const r = this.makeRow();
      this.rows.push(r);
      this.rowsEl.append(r.el);
    }
    while (this.rows.length > n) this.rows.pop()!.el.remove();
    this.update();
  }

  private index(levels: Level[]): Map<number, Cell> {
    const m = new Map<number, Cell>();
    let cum = 0;
    for (const l of levels) {
      cum += l.qty;
      m.set(l.price, { qty: l.qty, cum, mine: l.mine, orders: l.orders });
    }
    return m;
  }

  update(): void {
    const { bids, asks, s } = this.app;
    const n = this.rows.length;
    if (!n) return;
    const mid = s.bid && s.ask ? (s.bid + s.ask) / 2 : s.last;

    // Re-centre only when the price gets close to the top or bottom edge.
    const half = Math.floor(n / 2);
    const margin = Math.max(3, Math.floor(n * 0.22));
    const spreadTicks = s.bid && s.ask ? s.ask - s.bid : 0;
    // In a crash the spread can be wider than the whole ladder. Then the rows
    // would all be empty, so show the offers above and the bids below with the
    // gap between them folded into one row.
    const folded = spreadTicks > Math.max(8, n - 12);
    if (folded) this.center = 0;
    else if (!this.center || Math.abs(mid - this.center) > half - margin) this.center = Math.round(mid);
    const top = this.center + half;
    const priceAt = (i: number): number => {
      if (!folded) return top - i;
      if (i < half) return s.ask + (half - 1 - i);
      if (i === half) return 0;
      return s.bid - (i - half - 1);
    };

    const bidMap = this.index(bids);
    const askMap = this.index(asks);

    // Bar scale: the largest single level in view, eased so bars do not all jump together.
    let maxQ = 1;
    for (let i = 0; i < n; i++) {
      const p = priceAt(i);
      const c = p >= s.ask ? askMap.get(p) : bidMap.get(p);
      if (c && c.qty > maxQ) maxQ = c.qty;
    }
    this.barMax = maxQ > this.barMax ? maxQ : this.barMax + (maxQ - this.barMax) * 0.15;

    for (let i = 0; i < n; i++) {
      const r = this.rows[i];
      const p = priceAt(i);
      if (p === 0) {
        // The folded gap.
        const text = `${spreadTicks} ticks`;
        if (r.price !== 0) { r.price = 0; setText(r.q, ''); setText(r.t, ''); r.bar.style.transform = 'scaleX(0)'; r.scale = 0; r.el.title = ''; r.title = ''; }
        setText(r.p, '···');
        setText(r.q, text);
        if (r.cls !== 'row gap fold') { r.el.className = 'row gap fold'; r.cls = 'row gap fold'; }
        continue;
      }
      const isAsk = s.ask > 0 && p >= s.ask;
      const isBid = s.bid > 0 && p <= s.bid;
      const c = isAsk ? askMap.get(p) : isBid ? bidMap.get(p) : undefined;
      const lo = p < mid;
      let cls = `row ${isAsk ? 'ask' : isBid ? 'bid' : 'gap'} ${lo ? 'lo' : p > mid ? 'hi' : ''}`;
      if (!c) cls += ' vacant';
      if (c && c.mine > 0) cls += ' mine';
      if (p === s.bid || p === s.ask) cls += ' touch';
      if (p === s.last) cls += ' traded';

      if (r.price !== p) {
        r.price = p;
        setText(r.p, px(p));
      }
      setText(r.q, c ? qty(c.qty) : '');
      setText(r.t, c ? compact(c.cum) : '');
      if (cls !== r.cls) {
        r.el.className = cls;
        r.cls = cls;
      }
      const scale = c ? Math.min(1, c.qty / this.barMax) : 0;
      if (Math.abs(scale - r.scale) > 0.004) {
        r.bar.style.transform = `scaleX(${scale.toFixed(3)})`;
        r.scale = scale;
      }
      const title = c ? (c.mine > 0 ? `${qty(c.mine)} of this is yours. Right-click to cancel.` : `${c.orders} order${c.orders === 1 ? '' : 's'}`) : '';
      if (title !== r.title) {
        r.el.title = title;
        r.title = title;
      }
    }

    const tone = this.tone.push(s.last);
    setText(this.lastEl, px(s.last));
    const lastCls = `last ${tone}`;
    if (this.lastEl.className !== lastCls) this.lastEl.className = lastCls;
    const spread = s.bid && s.ask ? s.ask - s.bid : 0;
    setText(this.metaEl, spread ? `spread ${spread} tick${spread === 1 ? '' : 's'}` : 'one-sided');
    let b5 = 0, a5 = 0;
    for (let i = 0; i < 5; i++) {
      b5 += bids[i]?.qty ?? 0;
      a5 += asks[i]?.qty ?? 0;
    }
    this.imbEl.style.transform = `scaleX(${(b5 / Math.max(1, b5 + a5)).toFixed(3)})`;
  }
}
