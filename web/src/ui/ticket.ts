// Order ticket: build an order, see what it will cost before sending it.
import type { App } from '../app';
import { $, h, setText } from '../dom';
import { Side, Tif, type Level } from '../engine';
import { money, px, qty } from '../fmt';

type Kind = 'limit' | 'market' | 'twap';

export class Ticket {
  side: Side = Side.Buy;
  kind: Kind = 'limit';
  private priceTouched = false;

  private root = $('panel-ticket');
  private buyBtn = h('button.buy', { type: 'button', 'aria-pressed': 'true' }, 'BUY');
  private sellBtn = h('button.sell', { type: 'button', 'aria-pressed': 'false' }, 'SELL');
  private kindBtns: Record<Kind, HTMLButtonElement>;
  private qtyIn = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '10', value: '100', 'aria-label': 'Quantity in shares' });
  private priceIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', 'aria-label': 'Limit price in dollars' });
  private secsIn = h('input', { type: 'number', inputmode: 'numeric', min: '5', step: '5', value: '60', 'aria-label': 'Seconds to spread the order over' });
  private tifSel = h('select.sel', { 'aria-label': 'Time in force' },
    h('option', { value: '0' }, 'Good till cancelled'),
    h('option', { value: '1' }, 'Immediate or cancel'),
    h('option', { value: '2' }, 'Fill or kill'));
  private postOnly = h('input', { type: 'checkbox' });
  private priceField: HTMLElement;
  private secsField: HTMLElement;
  private optsRow: HTMLElement;
  private estimate = h('div.estimate');
  private submit = h('button.submit.buy', { type: 'button' });
  private algoTitle = h('span');
  private algoBar = h('i');
  private algoNote = h('div.dim');
  private algoBox = h('div.algo-status', { hidden: true },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, this.algoTitle,
      h('button.btn.tiny.danger', { type: 'button', onclick: () => this.app.engine.algoCancel() }, 'Stop')),
    h('div.progress', this.algoBar), this.algoNote);
  private lastEstimate = '';

  constructor(private app: App) {
    const kindBtn = (k: Kind, label: string, title: string) =>
      h('button.seg', { type: 'button', title, onclick: () => this.setKind(k) }, label);
    this.kindBtns = {
      limit: kindBtn('limit', 'Limit', 'Name your price and wait in the queue'),
      market: kindBtn('market', 'Market', 'Trade now at whatever the book offers'),
      twap: kindBtn('twap', 'TWAP', 'Split a large order into small slices over time'),
    };

    const quickQty = h('div.quick', ...[100, 500, 1000, 5000].map((n) =>
      h('button', { type: 'button', onclick: () => { this.qtyIn.value = String(n); this.refresh(); } }, n >= 1000 ? `${n / 1000}K` : String(n))));
    const quickPx = h('div.quick',
      h('button', { type: 'button', onclick: () => this.setPrice(this.app.s.bid) }, 'Bid'),
      h('button', { type: 'button', onclick: () => this.setPrice(Math.round(this.app.s.mid)) }, 'Mid'),
      h('button', { type: 'button', onclick: () => this.setPrice(this.app.s.ask) }, 'Ask'));
    const stepBtn = (d: number) => h('button.step', { type: 'button', 'aria-label': d > 0 ? 'Price up one cent' : 'Price down one cent', onclick: () => this.setPrice(this.priceTicks() + d) }, d > 0 ? '+' : '−');

    this.priceField = h('div.field',
      h('div.field-head', h('span.label', 'Limit price'), quickPx),
      h('div.input', stepBtn(-1), this.priceIn, stepBtn(1)));
    this.secsField = h('div.field', { hidden: true },
      h('div.field-head', h('span.label', 'Spread over')),
      h('div.input', this.secsIn, h('span.unit', 'SEC')));
    this.optsRow = h('div.row-2', this.tifSel,
      h('label.check', { title: 'Only ever add liquidity. The order is rejected if it would trade immediately.' }, this.postOnly, h('span.box'), 'Post only'));

    this.root.append(
      h('div.panel-head', h('h2', 'Order ticket'), h('span.legend', { id: 'ticket-pos' })),
      h('div.ticket',
        h('div.side-toggle', { role: 'group', 'aria-label': 'Side' }, this.buyBtn, this.sellBtn),
        h('div.seg-group', { role: 'group', 'aria-label': 'Order type' }, this.kindBtns.limit, this.kindBtns.market, this.kindBtns.twap),
        h('div.field',
          h('div.field-head', h('span.label', 'Quantity'), quickQty),
          h('div.input', this.qtyIn, h('span.unit', 'SHARES'))),
        this.priceField, this.secsField, this.optsRow, this.estimate, this.submit, this.algoBox));

    this.buyBtn.addEventListener('click', () => this.setSide(Side.Buy));
    this.sellBtn.addEventListener('click', () => this.setSide(Side.Sell));
    this.qtyIn.addEventListener('input', () => this.refresh());
    this.secsIn.addEventListener('input', () => this.refresh());
    this.priceIn.addEventListener('input', () => { this.priceTouched = true; this.refresh(); });
    this.priceIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.send(); });
    this.qtyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.send(); });
    this.submit.addEventListener('click', () => this.send());
    app.on('pick-price', ({ price, side }: { price: number; side: Side }) => {
      // Clicking a bid suggests joining the bid; clicking an offer suggests selling there.
      this.setKind('limit');
      this.setSide(side);
      this.setPrice(price);
    });
    app.on('restart', () => { this.priceTouched = false; });
    this.setKind('limit');
  }

  qty(): number {
    const v = Math.floor(Number(this.qtyIn.value));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 1_000_000) : 0;
  }
  private priceTicks(): number {
    return Math.round(Number(this.priceIn.value) * 100);
  }
  private setPrice(ticks: number): void {
    if (!(ticks > 0)) return;
    this.priceIn.value = (ticks / 100).toFixed(2);
    this.priceTouched = true;
    this.refresh();
  }
  setSide(side: Side): void {
    this.side = side;
    this.buyBtn.setAttribute('aria-pressed', String(side === Side.Buy));
    this.sellBtn.setAttribute('aria-pressed', String(side === Side.Sell));
    this.priceTouched = false;
    this.refresh();
  }
  setKind(kind: Kind): void {
    this.kind = kind;
    for (const k of Object.keys(this.kindBtns) as Kind[]) this.kindBtns[k].setAttribute('aria-pressed', String(k === kind));
    this.priceField.hidden = kind !== 'limit';
    this.optsRow.hidden = kind !== 'limit';
    this.secsField.hidden = kind !== 'twap';
    this.refresh();
  }

  private send(): void {
    const q = this.qty();
    if (!q) return;
    if (this.kind === 'market') this.app.market(this.side, q);
    else if (this.kind === 'twap') this.app.twap(this.side, q, Math.max(5, Number(this.secsIn.value) || 60));
    else this.app.limit(this.side, this.priceTicks(), q, Number(this.tifSel.value) as Tif, this.postOnly.checked);
  }

  /** Walk the book to see what a marketable order of this size would pay. */
  private walk(levels: Level[], q: number, limit: number | null): { filled: number; cost: number; worst: number } {
    let filled = 0, cost = 0, worst = 0;
    for (const l of levels) {
      if (limit !== null && (this.side === Side.Buy ? l.price > limit : l.price < limit)) break;
      const take = Math.min(q - filled, l.qty - l.mine);
      if (take <= 0) continue;
      filled += take;
      cost += take * l.price;
      worst = l.price;
      if (filled >= q) break;
    }
    return { filled, cost, worst };
  }

  refresh(): void {
    const app = this.app;
    const s = app.s;
    if (!s) return;
    const buying = this.side === Side.Buy;
    if (!this.priceTouched && document.activeElement !== this.priceIn) {
      const def = buying ? s.bid : s.ask;
      if (def > 0) this.priceIn.value = (def / 100).toFixed(2);
    }
    const q = this.qty();
    const opposite = buying ? app.asks : app.bids;
    const rows: string[] = [];
    const line = (k: string, v: string, cls = '') => rows.push(`<div><span class="k">${k}</span><span class="${cls}">${v}</span></div>`);
    const note = (t: string) => rows.push(`<span class="note">${t}</span>`);
    let label = `${buying ? 'Buy' : 'Sell'} ${qty(q)} TFX`;
    let ok = q > 0;

    if (this.kind === 'market') {
      const w = this.walk(opposite, q, null);
      if (w.filled > 0) {
        const avg = w.cost / w.filled;
        const slip = (buying ? avg - s.mid : s.mid - avg) * w.filled;
        line('Est. average price', px(avg));
        line('Cost of crossing', `${money(slip, false)} · ${(Math.abs(avg - s.mid)).toFixed(1)} ticks`, slip > 0 ? 'down' : '');
        line('Exchange fee', money(s.takerFee * w.filled, false));
        if (w.filled < q) note(`Only ${qty(w.filled)} shares are on offer. The rest will be cancelled.`);
        else if (Math.abs(w.worst - (buying ? s.ask : s.bid)) >= 3) note(`This walks the book ${Math.abs(w.worst - (buying ? s.ask : s.bid))} ticks to ${px(w.worst)}.`);
      } else if (q > 0) note('Nothing on the other side to trade with right now.');
      label += ' at market';
    } else if (this.kind === 'limit') {
      const p = this.priceTicks();
      const valid = p > 0;
      ok = ok && valid;
      this.priceIn.parentElement!.classList.toggle('invalid', !valid && this.priceIn.value !== '');
      if (valid && q > 0) {
        const marketable = buying ? s.ask > 0 && p >= s.ask : s.bid > 0 && p <= s.bid;
        if (marketable) {
          const w = this.walk(opposite, q, p);
          line('Trades immediately', `${qty(w.filled)} @ ${px(w.cost / Math.max(1, w.filled))}`);
          line('Exchange fee', money(s.takerFee * w.filled, false));
          if (this.postOnly.checked) note('Post only is on, so this order will be rejected, not filled.');
          else if (w.filled < q) note(`The other ${qty(q - w.filled)} will rest at ${px(p)}.`);
        } else {
          const same = buying ? app.bids : app.asks;
          const level = same.find((l) => l.price === p);
          const away = buying ? s.bid - p : p - s.ask;
          line('Queue ahead of you', level ? `${qty(level.qty - level.mine)} shares` : away < 0 ? 'none · new best price' : 'none');
          line('If filled you earn', `${money(s.makerRebate * q, false)} rebate`);
          note(away < 0 ? 'Inside the spread: you become the best price and trade first.' : away === 0 ? 'Joins the back of the queue at the best price.' : `${away} tick${away === 1 ? '' : 's'} behind the best price. It fills only if the market comes to you.`);
        }
        label += ` @ ${px(p)}`;
      }
    } else {
      const secs = Math.max(5, Number(this.secsIn.value) || 60);
      const w = this.walk(opposite, q, null);
      if (q > 0 && w.filled > 0) {
        const nowAvg = w.cost / w.filled;
        line('All at once would cost', `${Math.abs(nowAvg - s.mid).toFixed(1)} ticks/share`);
        line('Slices', `${qty(Math.ceil(q / (secs * 4)))} shares every 0.25s`);
        note('Trading slowly lets the book refill between slices. You pay less impact but take the risk that the price drifts.');
      }
      label += ` over ${secs}s`;
    }

    const html = rows.join('');
    if (html !== this.lastEstimate) {
      this.estimate.innerHTML = html;
      this.lastEstimate = html;
    }
    setText(this.submit, label);
    this.submit.className = `submit ${buying ? 'buy' : 'sell'}`;
    this.submit.disabled = !ok || s.haltRemaining > 0;

    // Running execution algo.
    if (s.algoActive || (s.algoTarget > 0 && s.algoDone > 0 && s.algoDone < s.algoTarget)) {
      this.algoBox.hidden = !s.algoActive;
    } else {
      this.algoBox.hidden = true;
    }
    if (!this.algoBox.hidden) {
      const frac = s.algoTarget ? s.algoDone / s.algoTarget : 0;
      setText(this.algoTitle, `TWAP ${s.algoSide === Side.Buy ? 'buy' : 'sell'} ${qty(s.algoDone)} / ${qty(s.algoTarget)}`);
      this.algoBar.style.width = `${(frac * 100).toFixed(1)}%`;
      setText(this.algoNote, `avg ${s.algoDone ? px(s.algoAvg) : '—'} · ${s.algoShortfall.toFixed(1)} ticks vs arrival`);
    }

    const pos = $('ticket-pos');
    const posText = s.position === 0 ? 'Flat' : `${s.position > 0 ? 'Long' : 'Short'} ${qty(Math.abs(s.position))}`;
    if (pos.textContent !== posText) {
      pos.textContent = posText;
      pos.className = `legend ${s.position > 0 ? 'up' : s.position < 0 ? 'down' : ''}`;
    }
  }
}
