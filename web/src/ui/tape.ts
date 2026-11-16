// Time and sales: every trade as it prints, newest on top.
import type { App } from '../app';
import { $, h } from '../dom';
import { KIND_TAGS, Side, type Trade } from '../engine';
import { clock, px, qty } from '../fmt';

const MAX_ROWS = 70;
const PER_FRAME = 24;

export class Tape {
  private el = $('tape');
  private rateEl = $('tape-rate');
  private rate = 0;
  private lastTrades = -1;
  private lastTime = 0;

  constructor(private app: App) {
    app.on('trades', (fresh: Trade[]) => this.add(fresh));
    app.on('restart', () => {
      this.el.textContent = '';
      this.lastTrades = -1;
    });
  }

  private add(fresh: Trade[]): void {
    // At high speed a frame can carry hundreds of trades; show the latest few.
    const from = Math.max(0, fresh.length - PER_FRAME);
    const frag = document.createDocumentFragment();
    for (let i = fresh.length - 1; i >= from; i--) {
      const t = fresh[i];
      const you = t.takerKind === 0 || t.makerKind === 0;
      const row = h(
        `div.trow.new${you ? '.you' : ''}${t.qty >= 300 ? '.big' : ''}`,
        h('span', clock(t.time)),
        h(`span.${t.side === Side.Buy ? 'up' : 'down'}`, px(t.price)),
        h('span', qty(t.qty)),
        h('span.who', you ? 'YOU' : KIND_TAGS[t.takerKind]),
      );
      frag.append(row);
    }
    this.el.prepend(frag);
    while (this.el.childElementCount > MAX_ROWS) this.el.lastElementChild!.remove();
  }

  update(): void {
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
