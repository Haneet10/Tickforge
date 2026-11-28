// Candlestick chart, drawn by hand on a 2D canvas.
//
// Candles are aggregated on the fly from the one-second history, so changing
// the interval is instant and there is nothing to keep in sync.
import type { App } from '../app';
import { clamp, cssVar, fitCanvas, setText } from '../dom';
import { Side } from '../engine';
import { clock, compact, px } from '../fmt';
import { ease } from './motion';

const AXIS_W = 64;
const AXIS_H = 20;
const VOLUME_FRACTION = 0.17;
const RIGHT_PAD = 4; // empty candle slots to the right of the live candle

interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  halted: boolean;
}

export class Chart {
  tf = 15;
  showVwap = true;
  showValue = true;

  private ctx: CanvasRenderingContext2D;
  private candleW = 9;
  private offset = 0; // candles scrolled back from live (fractional while dragging)
  private hover: { x: number; y: number } | null = null;
  private drag: { x: number; offset: number } | null = null;
  private pinch: { dist: number; w: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private col: Record<string, string> = {};
  private yLo = NaN;
  private yHi = NaN;
  private lastLegend = '';
  private legendAt = 0;
  // Smoothed state, so the picture glides instead of ticking.
  private lastFrame = 0;
  private scroll = NaN; // eased index of the live candle
  private liveIdx = -1;
  private liveC = NaN; // eased close of the live candle
  liveUp = true;
  private lastY = NaN; // eased last-price line

  constructor(
    private app: App,
    private canvas: HTMLCanvasElement,
    private legend: HTMLElement,
    private liveBtn: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    for (const k of ['up', 'down', 'up-dim', 'down-dim', 'line', 'line-strong', 'text', 'dim', 'faint', 'amber', 'cyan', 'violet'])
      this.col[k] = cssVar('--' + k);
    this.bind();
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.pan(e.deltaX / this.candleW);
      } else {
        this.zoom(Math.exp(-e.deltaY * 0.0016));
      }
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) this.drag = { x: e.offsetX, offset: this.offset };
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: this.candleW };
        this.drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.candleW = clamp(this.pinch.w * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, this.pinch.dist)), 3, 30);
      } else if (this.drag) {
        this.setOffset(this.drag.offset + (e.offsetX - this.drag.x) / this.candleW);
      }
      this.hover = e.pointerType === 'touch' && this.pointers.size !== 1 ? null : { x: e.offsetX, y: e.offsetY };
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.drag = null;
      this.pinch = null;
      if (e.pointerType === 'touch') this.hover = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => (this.hover = null));
    c.addEventListener('dblclick', () => this.goLive());
    this.liveBtn.addEventListener('click', () => this.goLive());
  }

  goLive(): void {
    this.offset = 0;
    this.liveBtn.hidden = true;
  }
  private setOffset(v: number): void {
    const maxBack = Math.max(0, Math.floor(this.app.history.n / this.tf) - 10) + RIGHT_PAD;
    this.offset = clamp(v, 0, maxBack);
    this.liveBtn.hidden = this.offset < RIGHT_PAD + 1;
  }
  private pan(candles: number): void {
    this.setOffset(this.offset - candles);
  }
  private zoom(f: number): void {
    this.candleW = clamp(this.candleW * f, 3, 30);
  }
  setTf(tf: number): void {
    this.tf = tf;
    this.scroll = NaN;
    this.liveIdx = -1;
    this.goLive();
  }

  private candle(index: number): Candle | null {
    const hist = this.app.history;
    const from = index * this.tf;
    const to = Math.min(from + this.tf - 1, hist.n);
    if (from < 0 || from > hist.n) return null;
    let h = -Infinity, l = Infinity, v = 0, halted = false;
    for (let i = from; i <= to; i++) {
      if (hist.high[i] > h) h = hist.high[i];
      if (hist.low[i] < l) l = hist.low[i];
      v += hist.volume[i];
      if (hist.halted[i]) halted = true;
    }
    return { o: hist.open[from], h, l, c: hist.close[to], v, halted };
  }

  draw(): void {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    const app = this.app;
    const hist = app.history;
    const C = this.col;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (w < 80 || h < 80) return;

    const plotW = w - AXIS_W;
    const plotH = h - AXIS_H;
    const volH = Math.round(plotH * VOLUME_FRACTION);
    const priceH = plotH - volH - 6;
    const cw = this.candleW;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    const lastIdx = Math.floor(hist.n / this.tf);
    // When a new candle opens, glide the chart one slot left instead of jumping.
    if (!Number.isFinite(this.scroll) || Math.abs(lastIdx - this.scroll) > 3) this.scroll = lastIdx;
    else this.scroll = ease(this.scroll, lastIdx, dt, 0.16);
    const rightF = this.scroll + RIGHT_PAD - this.offset;
    const rightIdx = Math.ceil(rightF);
    const visible = Math.ceil(plotW / cw) + 2;
    const leftIdx = rightIdx - visible + 1;
    const xOf = (idx: number) => plotW - (rightF - idx + 0.5) * cw;

    // The live candle's close follows trades through a short filter. Prints
    // bounce between the bid and the ask, and drawing every one makes the
    // candle flicker. Its colour only changes once the move is clear.
    const liveRaw = this.candle(lastIdx);
    if (liveRaw) {
      if (this.liveIdx !== lastIdx) {
        if (this.liveIdx >= 0 && lastIdx === this.liveIdx + 1) {
          const prev = this.candle(this.liveIdx);
          if (prev) this.liveUp = prev.c !== prev.o ? prev.c > prev.o : this.liveUp;
        }
        this.liveIdx = lastIdx;
        this.liveC = liveRaw.c;
      }
      this.liveC = clamp(ease(this.liveC, liveRaw.c, dt, 0.45), liveRaw.l, liveRaw.h);
      const d = this.liveC - liveRaw.o;
      if (d > 0.9) this.liveUp = true;
      else if (d < -0.9) this.liveUp = false;
    }

    // Gather candles and the visible range.
    const candles: (Candle | null)[] = [];
    let lo = Infinity, hi = -Infinity, vmax = 1;
    for (let i = leftIdx; i <= rightIdx; i++) {
      const c = i >= 0 && i <= lastIdx ? this.candle(i) : null;
      if (c && i === lastIdx && Number.isFinite(this.liveC)) c.c = this.liveC;
      candles.push(c);
      if (!c) continue;
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
      if (c.v > vmax) vmax = c.v;
    }
    if (!isFinite(lo)) return;
    const pad = Math.max(2, (hi - lo) * 0.09);
    lo -= pad;
    hi += pad;
    // Ease the scale so it does not twitch with every tick.
    if (!Number.isFinite(this.yLo) || Math.abs(this.yLo - lo) > (hi - lo) * 2 || Math.abs(this.yHi - hi) > (hi - lo) * 2) {
      this.yLo = lo;
      this.yHi = hi;
    } else {
      const tau = this.drag ? 0.08 : 0.45;
      this.yLo = ease(this.yLo, lo, dt, tau);
      this.yHi = ease(this.yHi, hi, dt, tau);
    }
    const yLo = this.yLo, yHi = this.yHi;
    const yOf = (p: number) => 4 + (1 - (p - yLo) / (yHi - yLo)) * (priceH - 4);
    const pOf = (y: number) => yLo + (1 - (y - 4) / (priceH - 4)) * (yHi - yLo);

    ctx.font = `11px ${cssFont}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    // Price grid.
    const step = niceStep((yHi - yLo) / Math.max(2, priceH / 46));
    ctx.strokeStyle = C.line;
    ctx.fillStyle = C.faint;
    ctx.textAlign = 'left';
    ctx.beginPath();
    for (let p = Math.ceil(yLo / step) * step; p < yHi; p += step) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.fillText(px(p), plotW + 8, y);
    }
    ctx.stroke();

    // Time grid and labels.
    const tStep = timeStep((90 / cw) * this.tf, this.tf);
    ctx.textAlign = 'center';
    ctx.beginPath();
    for (let i = leftIdx; i <= rightIdx; i++) {
      const t = i * this.tf;
      if (t < 0 || t % tStep !== 0) continue;
      const x = Math.round(xOf(i) - cw / 2) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.fillText(clock(t).slice(0, tStep < 60 ? 8 : 5), x, plotH + AXIS_H / 2 + 1);
    }
    ctx.stroke();

    // Axis rules.
    ctx.strokeStyle = C['line-strong'];
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, plotH);
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    // Candles and volume.
    const bodyW = Math.max(1, Math.floor(cw * 0.72));
    for (let n = 0; n < candles.length; n++) {
      const c = candles[n];
      if (!c) continue;
      const x = xOf(leftIdx + n);
      const up = leftIdx + n === lastIdx ? this.liveUp : c.c >= c.o;
      if (c.halted) {
        ctx.fillStyle = 'rgba(255,178,36,0.07)';
        ctx.fillRect(x - cw / 2, 0, cw, plotH);
      }
      ctx.fillStyle = up ? C['up-dim'] : C['down-dim'];
      const vh = Math.max(1, (c.v / vmax) * (volH - 4));
      ctx.fillRect(Math.round(x - bodyW / 2), plotH - vh, bodyW, vh);

      ctx.fillStyle = ctx.strokeStyle = up ? C.up : C.down;
      const xc = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xc, yOf(c.h));
      ctx.lineTo(xc, yOf(c.l));
      ctx.stroke();
      const y0 = yOf(Math.max(c.o, c.c));
      const y1 = yOf(Math.min(c.o, c.c));
      if (leftIdx + n === lastIdx) ctx.fillRect(Math.round(x - bodyW / 2), y0, bodyW, Math.max(1, y1 - y0));
      else ctx.fillRect(Math.round(x - bodyW / 2), Math.round(y0), bodyW, Math.max(1, Math.round(y1 - y0)));
    }

    // Lines that follow the candles: VWAP, true value, the bot's quotes.
    const series = (get: (sec: number) => number, color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let n = 0; n < candles.length; n++) {
        if (!candles[n]) continue;
        const sec = Math.min((leftIdx + n + 1) * this.tf - 1, hist.n);
        const v = get(sec);
        if (!(v > 0)) { started = false; continue; }
        const x = xOf(leftIdx + n), y = yOf(v);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    };
    if (this.showVwap) series((i) => hist.vwapAt(i), C.cyan, 1);
    if (this.showValue && app.xray) series((i) => hist.value[i], C.amber, 1.4);
    if (app.s.botEnabled || hist.botBid[Math.max(0, hist.n - 1)] > 0) {
      series((i) => hist.botBid[i], C.violet, 1, [2, 3]);
      series((i) => hist.botAsk[i], C.violet, 1, [2, 3]);
    }

    // Scenario and halt markers.
    ctx.font = `600 9.5px ${cssSans}`;
    ctx.textAlign = 'left';
    // A short warm-up (a lab session) can leave the market's first second on
    // screen. Say so, so the empty space reads as "before the open".
    if (leftIdx < 0) {
      const x = Math.round(xOf(-0.5)) + 0.5;
      ctx.strokeStyle = C.line;
      ctx.beginPath();
      ctx.moveTo(x, 16);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillStyle = C.faint;
      ctx.textAlign = 'right';
      ctx.fillText(spaced('MARKET OPENS'), x - 6, 9);
      ctx.textAlign = 'left';
    }
    for (const m of app.marks) {
      const idx = Math.floor(m.time / this.tf);
      if (idx < leftIdx || idx > rightIdx) continue;
      const x = Math.round(xOf(idx)) + 0.5;
      const color = m.tone === 'up' ? C.up : m.tone === 'down' ? C.down : m.tone === 'warn' ? C.amber : C.cyan;
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 16);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(spaced(m.label), x + 4, 9);
    }
    ctx.font = `11px ${cssFont}`;

    // The user's fills: one marker per candle and side, at the average price, so a
    // busy bot does not bury the candles under hundreds of triangles.
    const fills = app.fills;
    const groups = new Map<number, { pv: number; q: number }>();
    for (let n = fills.length - 1; n >= 0; n--) {
      const f = fills[n];
      const idx = Math.floor(f.time / this.tf);
      if (idx < leftIdx) break;
      if (idx > rightIdx) continue;
      const key = idx * 2 + (f.side === Side.Buy ? 0 : 1);
      const g = groups.get(key);
      if (g) { g.pv += f.price * f.qty; g.q += f.qty; }
      else groups.set(key, { pv: f.price * f.qty, q: f.qty });
    }
    ctx.strokeStyle = '#000';
    for (const [key, g] of groups) {
      const buy = key % 2 === 0;
      const x = xOf((key - (buy ? 0 : 1)) / 2), y = yOf(g.pv / g.q);
      ctx.fillStyle = buy ? C.up : C.down;
      ctx.beginPath();
      if (buy) { ctx.moveTo(x, y + 2); ctx.lineTo(x - 5, y + 10); ctx.lineTo(x + 5, y + 10); }
      else { ctx.moveTo(x, y - 2); ctx.lineTo(x - 5, y - 10); ctx.lineTo(x + 5, y - 10); }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // The user's resting orders.
    const tag = (y: number, text: string, bg: string, fg: string) => {
      ctx.fillStyle = bg;
      ctx.fillRect(plotW + 1, Math.round(y) - 8, AXIS_W - 1, 16);
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.fillText(text, plotW + 8, Math.round(y) + 0.5);
    };
    for (const o of app.orders) {
      const y = yOf(o.price);
      if (y < 0 || y > priceH) continue;
      const color = o.side === Side.Buy ? C.up : C.down;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Last price.
    const s = app.s;
    const lastUp = this.liveUp;
    this.lastY = ease(this.lastY, Number.isFinite(this.liveC) ? this.liveC : s.last, dt, 0.12);
    const yLast = yOf(this.lastY);
    if (yLast >= 0 && yLast <= priceH) {
      ctx.strokeStyle = lastUp ? C.up : C.down;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yLast) + 0.5);
      ctx.lineTo(plotW, Math.round(yLast) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      tag(yLast, px(s.last), lastUp ? C.up : C.down, '#000');
    }

    // Crosshair and legend.
    let legendIdx = lastIdx;
    if (this.hover && this.hover.x < plotW && this.hover.y < plotH && !this.drag) {
      const hx = this.hover.x, hy = this.hover.y;
      const idx = clamp(Math.round(rightF - (plotW - hx) / cw + 0.5), Math.max(0, leftIdx), lastIdx);
      legendIdx = idx;
      const x = Math.round(xOf(idx)) + 0.5;
      ctx.strokeStyle = C.faint;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      if (hy < priceH) { ctx.moveTo(0, Math.round(hy) + 0.5); ctx.lineTo(plotW, Math.round(hy) + 0.5); }
      ctx.stroke();
      ctx.setLineDash([]);
      if (hy < priceH) tag(hy, px(pOf(hy)), '#2a3038', C.text);
      const label = clock(idx * this.tf);
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#2a3038';
      ctx.fillRect(clamp(x - tw / 2, 0, plotW - tw), plotH + 1, tw, AXIS_H - 1);
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center';
      ctx.fillText(label, clamp(x, tw / 2, plotW - tw / 2), plotH + AXIS_H / 2 + 1);
    }
    const lc = this.candle(legendIdx);
    if (lc && legendIdx === lastIdx && !this.hover && now - this.legendAt < 250) {
      // The live legend refreshes four times a second; the numbers are unreadable faster.
    } else if (lc) {
      this.legendAt = now;
      const tone = (legendIdx === lastIdx ? this.liveUp : lc.c >= lc.o) ? 'up' : 'down';
      const html =
        `<span class="k">O</span><b class="${tone}">${px(lc.o)}</b><span class="k">H</span><b class="${tone}">${px(lc.h)}</b>` +
        `<span class="k">L</span><b class="${tone}">${px(lc.l)}</b><span class="k">C</span><b class="${tone}">${px(lc.c)}</b>` +
        `<span class="k">VOL</span><b>${compact(lc.v)}</b>`;
      if (html !== this.lastLegend) {
        this.legend.innerHTML = html;
        this.lastLegend = html;
      }
    } else {
      setText(this.legend, '');
    }
  }
}

const cssFont = `'IBM Plex Mono', ui-monospace, monospace`;
const cssSans = `'IBM Plex Sans Condensed', system-ui, sans-serif`;

function spaced(s: string): string {
  return s.split('').join(' ');
}

function niceStep(raw: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const s of steps) if (s >= raw) return s;
  return 10000;
}

function timeStep(minSeconds: number, tf: number): number {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  for (const s of steps) if (s >= minSeconds && s % tf === 0) return s;
  return 14400;
}
