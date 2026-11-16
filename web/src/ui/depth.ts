// Cumulative depth: how many shares you could trade before the price reaches each level.
import type { App } from '../app';
import { clamp, cssVar, fitCanvas } from '../dom';
import { compact, px, qty } from '../fmt';

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
    const mid = s.mid;

    // Show enough of the book to be interesting: out to roughly the 14th level.
    const reach = Math.max(mid - (bids[Math.min(13, bids.length - 1)]?.price ?? mid), (asks[Math.min(13, asks.length - 1)]?.price ?? mid) - mid);
    this.span += (clamp(reach * 1.15, 12, 400) - this.span) * 0.08;
    const span = this.span;
    const axisH = 16;
    const plotH = h - axisH;
    const xOf = (p: number) => ((p - (mid - span)) / (2 * span)) * w;

    let cb = 0, ca = 0;
    for (const l of bids) { if (l.price < mid - span) break; cb += l.qty; }
    for (const l of asks) { if (l.price > mid + span) break; ca += l.qty; }
    this.top += (Math.max(cb, ca, 100) * 1.12 - this.top) * 0.1;
    const yOf = (q: number) => plotH - (q / this.top) * (plotH - 6);

    ctx.strokeStyle = this.line;
    ctx.beginPath();
    ctx.moveTo(Math.round(w / 2) + 0.5, 0);
    ctx.lineTo(Math.round(w / 2) + 0.5, plotH);
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();

    const side = (levels: typeof bids, dir: 1 | -1, color: string) => {
      ctx.beginPath();
      let cum = 0;
      let x = xOf(levels[0].price + (dir > 0 ? -0.5 : 0.5));
      ctx.moveTo(x, plotH);
      for (const l of levels) {
        if (Math.abs(l.price - mid) > span + 1) break;
        x = xOf(l.price + (dir > 0 ? -0.5 : 0.5));
        ctx.lineTo(x, yOf(cum));
        cum += l.qty;
        ctx.lineTo(x, yOf(cum));
      }
      const edge = dir > 0 ? w : 0;
      ctx.lineTo(edge, yOf(cum));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.lineTo(edge, plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, plotH);
      g.addColorStop(0, color + '55');
      g.addColorStop(1, color + '08');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1;
    };
    side(bids, -1, this.up);
    side(asks, 1, this.down);

    ctx.font = `10.5px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = this.faint;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(px(mid - span), 4, plotH + axisH / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText(px(mid + span), w - 4, plotH + axisH / 2 + 1);
    ctx.textAlign = 'center';
    ctx.fillText(px(mid), w / 2, plotH + axisH / 2 + 1);

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
