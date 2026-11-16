// Order book ladder: asks above, bids below, the spread in the middle.
import type { App } from '../app';
import { $, h, setText } from '../dom';
import { Side, type Level } from '../engine';
import { compact, px, qty } from '../fmt';

const ROW_H = 19;

interface Row {
  el: HTMLElement;
  p: HTMLElement;
  q: HTMLElement;
  t: HTMLElement;
  bar: HTMLElement;
  price: number;
  qty: number;
}

export class Ladder {
  private asksEl = $('book-asks');
  private bidsEl = $('book-bids');
  private midEl = $('book-mid');
  private askRows: Row[] = [];
  private bidRows: Row[] = [];
  private lastEl = h('span.last');
  private metaEl = h('span.meta');
  private imbEl = h('i');
  private prevQty = new Map<number, number>();
  private prevLast = 0;
  private lastTone = 'up';
  armed = false;

  constructor(private app: App, private ticketQty: () => number) {
    this.midEl.append(this.lastEl, h('span.imb', { title: 'Share of resting size on the bid across the top five levels' }, this.imbEl), this.metaEl);
    const armBox = $<HTMLInputElement>('click-trade');
    armBox.addEventListener('change', () => this.setArmed(armBox.checked));
    new ResizeObserver(() => this.layout()).observe($('book'));
    this.layout();
  }

  setArmed(on: boolean): void {
    this.armed = on;
    $<HTMLInputElement>('click-trade').checked = on;
    for (const r of this.askRows) r.el.classList.toggle('armed-sell', on);
    for (const r of this.bidRows) r.el.classList.toggle('armed-buy', on);
  }

  private makeRow(side: Side): Row {
    const p = h('span.p'), q = h('span.q'), t = h('span.t'), bar = h('i.bar');
    const el = h('div.row', bar, p, q, t);
    const row: Row = { el, p, q, t, bar, price: 0, qty: 0 };
    el.addEventListener('click', () => {
      if (!row.price) return;
      if (this.armed) this.app.limit(side, row.price, this.ticketQty());
      else this.app.emit('pick-price', { price: row.price, side });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      for (const o of this.app.orders) if (o.price === row.price) this.app.cancel(o.id);
    });
    if (this.armed) el.classList.add(side === Side.Buy ? 'armed-buy' : 'armed-sell');
    return row;
  }

  private layout(): void {
    const n = Math.max(3, Math.floor(this.asksEl.clientHeight / ROW_H));
    const fit = (rows: Row[], parent: HTMLElement, side: Side, prepend: boolean) => {
      while (rows.length < n) {
        const r = this.makeRow(side);
        rows.push(r);
        if (prepend) parent.prepend(r.el); else parent.append(r.el);
      }
      while (rows.length > n) rows.pop()!.el.remove();
    };
    // Ask rows are stored best-first but displayed best-at-the-bottom.
    fit(this.askRows, this.asksEl, Side.Sell, true);
    fit(this.bidRows, this.bidsEl, Side.Buy, false);
  }

  private fill(rows: Row[], levels: Level[], max: number): void {
    let cum = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lv = levels[i];
      if (!lv) {
        if (r.price) {
          r.price = 0;
          r.p.textContent = r.q.textContent = r.t.textContent = '';
          r.bar.style.width = '0';
          r.el.className = r.el.className.replace(/ ?(mine|flash-\w+)/g, '');
        }
        continue;
      }
      cum += lv.qty;
      const before = this.prevQty.get(lv.price);
      r.price = lv.price;
      r.qty = lv.qty;
      setText(r.p, px(lv.price));
      setText(r.q, lv.mine ? `${qty(lv.qty)}` : qty(lv.qty));
      setText(r.t, compact(cum));
      r.bar.style.width = `${Math.min(100, (cum / max) * 100).toFixed(1)}%`;
      r.el.classList.toggle('mine', lv.mine > 0);
      r.el.title = lv.mine > 0 ? `${qty(lv.mine)} of this is yours. Right-click to cancel.` : `${lv.orders} order${lv.orders === 1 ? '' : 's'}`;
      if (before !== undefined && before !== lv.qty) {
        const cls = lv.qty > before ? 'flash-up' : 'flash-down';
        r.el.classList.remove('flash-up', 'flash-down');
        void r.el.offsetWidth;
        r.el.classList.add(cls);
      }
    }
  }

  update(): void {
    const { bids, asks, s } = this.app;
    const n = this.askRows.length;
    let cb = 0, ca = 0;
    for (let i = 0; i < n; i++) {
      cb += bids[i]?.qty ?? 0;
      ca += asks[i]?.qty ?? 0;
    }
    const max = Math.max(cb, ca, 1);
    this.fill(this.askRows, asks, max);
    this.fill(this.bidRows, bids, max);

    this.prevQty.clear();
    for (let i = 0; i < n; i++) {
      if (bids[i]) this.prevQty.set(bids[i].price, bids[i].qty);
      if (asks[i]) this.prevQty.set(asks[i].price, asks[i].qty);
    }

    if (s.last !== this.prevLast) {
      this.lastTone = s.last > this.prevLast ? 'up' : 'down';
      this.prevLast = s.last;
    }
    setText(this.lastEl, px(s.last));
    this.lastEl.className = `last ${this.lastTone}`;
    const spread = s.bid && s.ask ? s.ask - s.bid : 0;
    setText(this.metaEl, spread ? `spread ${spread} tick${spread === 1 ? '' : 's'}` : 'one-sided');
    let b5 = 0, a5 = 0;
    for (let i = 0; i < 5; i++) {
      b5 += bids[i]?.qty ?? 0;
      a5 += asks[i]?.qty ?? 0;
    }
    this.imbEl.style.width = `${((b5 / Math.max(1, b5 + a5)) * 100).toFixed(0)}%`;
  }
}
