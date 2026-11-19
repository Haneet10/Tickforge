// Time and sales, newest on top.
//
// Trades are collected as they print and shown a few times a second instead of
// every frame. Consecutive prints at the same price, in the same direction and
// by the same kind of trader are merged into one line, the way most exchange
// feeds aggregate them. New lines slide in rather than jumping the list.
import type { App } from '../app';
import { $, h } from '../dom';
import { KIND_TAGS, Side, type Trade } from '../engine';
import { clock, px, qty } from '../fmt';
import { reducedMotion } from './motion';

const MAX_ROWS = 60;
const PER_FLUSH = 10;
const ROW_H = 18;

interface Line { time: number; price: number; qty: number; side: Side; who: string; you: boolean }

export class Tape {
  private el = $('tape');
  private rateEl = $('tape-rate');
  private rate = 0;
  private lastTrades = -1;
  private lastTime = 0;
  private pending: Line[] = [];

  constructor(private app: App) {
    app.on('trades', (fresh: Trade[]) => this.collect(fresh));
    app.on('restart', () => {
      this.el.textContent = '';
      this.pending = [];
      this.lastTrades = -1;
    });
  }

  private collect(fresh: Trade[]): void {
    for (const t of fresh) {
      const you = t.takerKind === 0 || t.makerKind === 0;
      const who = you ? 'YOU' : KIND_TAGS[t.takerKind];
      const prev = this.pending[this.pending.length - 1];
      if (prev && prev.price === t.price && prev.side === t.side && prev.you === you && Math.floor(prev.time) === Math.floor(t.time)) {
        prev.qty += t.qty;
        prev.time = t.time;
        if (prev.who !== who) prev.who = 'MIX';
      } else {
        this.pending.push({ time: t.time, price: t.price, qty: t.qty, side: t.side, who, you });
      }
    }
    // At high speed thousands of trades can arrive between flushes; keep the latest.
    if (this.pending.length > 4 * PER_FLUSH) this.pending.splice(0, this.pending.length - PER_FLUSH);
  }

  private flush(): void {
    if (!this.pending.length) return;
    const lines = this.pending.slice(-PER_FLUSH);
    this.pending = [];
    const frag = document.createDocumentFragment();
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i];
      frag.append(h(
        `div.trow.new${t.you ? '.you' : ''}${t.qty >= 300 ? '.big' : ''}`,
        h('span', clock(t.time)),
        h(`span.${t.side === Side.Buy ? 'up' : 'down'}`, px(t.price)),
        h('span', qty(t.qty)),
        h('span.who', t.who),
      ));
    }
    this.el.prepend(frag);
    while (this.el.childElementCount > MAX_ROWS) this.el.lastElementChild!.remove();
    // Slide the list down into place instead of jumping.
    if (!reducedMotion() && !document.hidden) {
      this.el.animate(
        [{ transform: `translateY(${-lines.length * ROW_H}px)` }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      );
    }
  }

  update(): void {
    this.flush();
    const s = this.app.s;
    if (this.lastTrades >= 0 && s.time > this.lastTime) {
      const inst = (s.trades - this.lastTrades) / (s.time - this.lastTime);
      this.rate += (inst - this.rate) * 0.05;
    }
    this.lastTrades = s.trades;
    this.lastTime = s.time;
    const text = `${this.rate.toFixed(1)} per second`;
    if (this.rateEl.textContent !== text) this.rateEl.textContent = text;
  }
}
