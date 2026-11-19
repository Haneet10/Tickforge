// Cumulative depth: how many shares you could trade before the price reaches each level.
import type { App } from '../app';
import { clamp, cssVar, fitCanvas } from '../dom';
import { compact, px, qty } from '../fmt';
import { ease } from './motion';

const STEP = 2; // pixels between samples of the curves

export class Depth {
  private ctx: CanvasRenderingContext2D;
  private span = 40;
  private top = 1000;
  private hoverX: number | null = null;
  private up = cssVar('--up');
  private down = cssVar('--down');
  private line = cssVar('--line');
  private faint = cssVar('--faint');
  private text = cssVar('--text');
  private center = NaN;
  private lastFrame = 0;
  private bidCurve = new Float64Array(0);
  private askCurve = new Float64Array(0);
  private bidEdge = NaN;
  private askEdge = NaN;

  constructor(private app: App, private canvas: HTMLCanvasElement, private legend: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointermove', (e) => (this.hoverX = e.offsetX));
    canvas.addEventListener('pointerleave', () => (this.hoverX = null));
  }

  draw(): void {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { bids, asks, s } = this.app;
    if (!bids.length || !asks.length) return;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    // The view is centred on an eased mid, so it does not lurch a tick at a time.
    if (!Number.isFinite(this.center) || Math.abs(s.mid - this.center) > this.span) this.center = s.mid;
    else this.center = ease(this.center, s.mid, dt, 0.3);
    const mid = this.center;

    // Show enough of the book to be interesting: out to roughly the 14th level.
    const reach = Math.max(s.mid - (bids[Math.min(13, bids.length - 1)]?.price ?? s.mid), (asks[Math.min(13, asks.length - 1)]?.price ?? s.mid) - s.mid);
    this.span = ease(this.span, clamp(reach * 1.15, 12, 400), dt, 0.6);
    const span = this.span;
    const axisH = 16;
    const plotH = h - axisH;
    const xOf = (p: number) => ((p - (mid - span)) / (2 * span)) * w;
    const pOf = (x: number) => mid - span + (x / w) * 2 * span;

    let cb = 0, ca = 0;
    for (const l of bids) { if (l.price < mid - span) break; cb += l.qty; }
    for (const l of asks) { if (l.price > mid + span) break; ca += l.qty; }
    this.top = ease(this.top, Math.max(cb, ca, 100) * 1.12, dt, 0.5);
    const yOf = (q: number) => plotH - (q / this.top) * (plotH - 6);

    // Sample both cumulative curves every few pixels and ease each sample, so
    // orders arriving and leaving make the curves breathe instead of jump.
    const n = Math.ceil(w / STEP) + 1;
    if (this.bidCurve.length !== n) {
      this.bidCurve = new Float64Array(n);
      this.askCurve = new Float64Array(n);
    }
    const k = 1 - Math.exp(-dt / 0.14);
    {
      let i = 0, cum = 0;
      for (let j = n - 1; j >= 0; j--) {
        const p = pOf(j * STEP);
        while (i < bids.length && bids[i].price + 0.5 >= p) cum += bids[i++].qty;
        this.bidCurve[j] += (cum - this.bidCurve[j]) * k;
      }
    }
    {
      let i = 0, cum = 0;
      for (let j = 0; j < n; j++) {
        const p = pOf(j * STEP);
        while (i < asks.length && asks[i].price - 0.5 <= p) cum += asks[i++].qty;
        this.askCurve[j] += (cum - this.askCurve[j]) * k;
      }
    }
    this.bidEdge = ease(this.bidEdge, xOf(bids[0].price + 0.5), dt, 0.14);
    this.askEdge = ease(this.askEdge, xOf(asks[0].price - 0.5), dt, 0.14);

    ctx.strokeStyle = this.line;
    ctx.beginPath();
    ctx.moveTo(Math.round(xOf(s.mid)) + 0.5, 0);
    ctx.lineTo(Math.round(xOf(s.mid)) + 0.5, plotH);
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();

    const side = (curve: Float64Array, from: number, to: number, edge: number, color: string) => {
      ctx.beginPath();
      ctx.moveTo(edge, plotH);
      const j0 = Math.max(0, Math.ceil(Math.min(from, to) / STEP)), j1 = Math.min(n - 1, Math.floor(Math.max(from, to) / STEP));
      if (from > to) for (let j = j1; j >= j0; j--) ctx.lineTo(j * STEP, yOf(curve[j]));
      else for (let j = j0; j <= j1; j++) ctx.lineTo(j * STEP, yOf(curve[j]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.lineTo(from > to ? 0 : w, plotH);
      ctx.lineTo(edge, plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, plotH);
      g.addColorStop(0, color + '55');
      g.addColorStop(1, color + '08');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1;
    };
    side(this.bidCurve, this.bidEdge, 0, this.bidEdge, this.up);
    side(this.askCurve, this.askEdge, w, this.askEdge, this.down);

    ctx.font = `10.5px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = this.faint;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(px(Math.round(mid - span)), 4, plotH + axisH / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText(px(Math.round(mid + span)), w - 4, plotH + axisH / 2 + 1);
    ctx.textAlign = 'center';
    ctx.fillText(px(Math.round(s.mid)), xOf(s.mid), plotH + axisH / 2 + 1);

    let legend = `<span class="k">BIDS</span><b class="up">${compact(cb)}</b><span class="k">ASKS</span><b class="down">${compact(ca)}</b>`;
    if (this.hoverX !== null) {
      const price = mid - span + (this.hoverX / w) * 2 * span;
      const buying = price > mid;
      let cum = 0;
      for (const l of buying ? asks : bids) {
        if (buying ? l.price > price : l.price < price) break;
        cum += l.qty;
      }
      const x = Math.round(this.hoverX) + 0.5;
      ctx.strokeStyle = this.faint;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this.text;
      ctx.beginPath();
      ctx.arc(x, yOf(cum), 2.5, 0, Math.PI * 2);
      ctx.fill();
      legend = `${buying ? 'Buying' : 'Selling'} <b>${qty(cum)}</b> moves it to <b class="${buying ? 'up' : 'down'}">${px(Math.round(price))}</b>`;
    }
    if (this.legend.innerHTML !== legend) this.legend.innerHTML = legend;
  }
}
