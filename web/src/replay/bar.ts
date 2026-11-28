// The replay transport: a strip above the status bar with the session drawn
// as a timeline (price, P&L and every action), a playhead you can drag, and
// the ways out (take over, exit).
import type { App } from '../app';
import { Side } from '../engine';
import { clamp, cssVar, fitCanvas, h, setText } from '../dom';
import { money } from '../fmt';
import { type Action, clockUs, orderCount } from './log';
import type { Player } from './player';

const STEP_US = 5e6;
const BIG_STEP_US = 30e6;

interface Palette {
  up: string; down: string; amber: string; cyan: string; dim: string; faint: string; line: string; text: string; mono: string; sans: string;
}

/** Colour and row for an action's tick on the timeline. */
function tickOf(a: Action, p: Palette): string | null {
  switch (a[0]) {
    case 'L': case 'M': case 'T': return a[1] === Side.Buy ? p.up : p.down;
    case 'X': case 'XA': case 'AX': return p.faint;
    case 'F': case 'R': return p.text;
    case 'S': case 'N': return p.amber;
    case 'B': case 'D': return p.cyan;
  }
}

export class ReplayBar {
  readonly el: HTMLElement;
  private app: App;
  private player: Player | null = null;
  private kicker = h('span.rp-kicker');
  private name = h('span.rp-name');
  private playBtn = h('button.icon-btn.rp-play', { type: 'button' });
  private playIcon: SVGPathElement;
  private time = h('span.rp-time');
  private track = h('div.rp-track', { role: 'slider', tabindex: '0', 'aria-label': 'Replay position', 'aria-valuemin': '0' });
  private canvas = h('canvas.rp-canvas');
  private result = h('span.rp-result', { 'aria-live': 'polite' });
  private takeBtn = h('button.btn.rp-take', { type: 'button', title: 'Keep this market exactly as it is and trade from here' }, 'Take over');
  private exitBtn = h('button.btn.ghost.rp-exit', { type: 'button', title: 'Leave the replay (Esc)' }, 'Exit replay');
  private hoverX = -1;
  private pendingSeek = -1;
  private dragging = false;
  private pal: Palette | null = null;
  private onExit: () => void;

  constructor(app: App, onExit: () => void) {
    this.app = app;
    this.onExit = onExit;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    this.playIcon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(this.playIcon);
    this.playBtn.append(svg);
    this.track.append(this.canvas);
    this.el = h('section.replay', { 'aria-label': 'Replay controls', hidden: true },
      h('div.rp-id', this.kicker, this.name),
      this.playBtn,
      this.time,
      this.track,
      this.result,
      h('div.rp-actions', this.takeBtn, this.exitBtn));

    this.playBtn.addEventListener('click', () => {
      const p = this.player;
      if (!p) return;
      if (p.state === 'ended') {
        p.seek(0);
        app.paused = false;
        app.emit('speed');
      } else {
        app.togglePause();
      }
      this.sync();
    });
    this.takeBtn.addEventListener('click', () => this.player?.takeOver());
    this.exitBtn.addEventListener('click', () => this.onExit());

    this.track.addEventListener('pointerdown', (e) => {
      if (!this.player) return;
      this.dragging = true;
      this.track.setPointerCapture(e.pointerId);
      this.queueSeek(this.timeAt(e.clientX));
    });
    this.track.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      if (this.dragging) this.queueSeek(this.timeAt(e.clientX));
    });
    const stop = () => (this.dragging = false);
    this.track.addEventListener('pointerup', stop);
    this.track.addEventListener('pointercancel', stop);
    this.track.addEventListener('pointerleave', () => (this.hoverX = -1));
    this.track.addEventListener('keydown', (e) => {
      const p = this.player;
      if (!p) return;
      const step = e.shiftKey ? BIG_STEP_US : STEP_US;
      let t = -1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = p.cursor - step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = p.cursor + step;
      else if (e.key === 'PageDown') t = p.cursor - BIG_STEP_US;
      else if (e.key === 'PageUp') t = p.cursor + BIG_STEP_US;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = p.length;
      if (t < 0 && e.key !== 'Home') return;
      e.preventDefault();
      this.queueSeek(clamp(t, 0, p.length));
    });
    window.addEventListener('resize', () => this.player && this.draw());
  }

  attach(player: Player | null): void {
    this.player = player;
    this.el.hidden = !player;
    document.documentElement.classList.toggle('replaying', !!player);
    this.pendingSeek = -1;
    this.dragging = false;
    if (!player) return;
    this.pal = null;
    const log = player.log;
    if (log.watch) {
      setText(this.kicker, 'WATCHING');
      setText(this.name, log.watch.label ?? `Strategy session ${log.seed}`);
    } else {
      setText(this.kicker, 'REPLAY');
      const n = orderCount(log);
      setText(this.name, `Seed ${log.seed} · ${n} order${n === 1 ? '' : 's'}`);
    }
    this.takeBtn.hidden = !player.canTakeOver;
    this.track.setAttribute('aria-valuemax', String(Math.round(player.length / 1e6)));
    this.sync();
  }

  /** Called when the player ends or seeks. */
  sync(): void {
    const p = this.player;
    if (!p) return;
    const ended = p.state === 'ended';
    const paused = this.app.paused && !ended;
    this.playIcon.setAttribute('d', ended
      ? 'M8 2.5a5.5 5.5 0 1 1-5.2 3.7l1.4.5A4 4 0 1 0 8 4v2L4.8 3.2 8 .5z'
      : paused ? 'M4 3l9 5-9 5z' : 'M4 3h3v10H4zM9 3h3v10H9z');
    this.playBtn.setAttribute('aria-label', ended ? 'Replay from the start' : paused ? 'Play' : 'Pause');
    this.playBtn.title = ended ? 'Replay from the start' : 'Play or pause (Space)';

    this.result.replaceChildren();
    if (ended && p.result && p.log.watch) {
      const pnl = p.result.pnl;
      const expect = p.log.watch.expect;
      const same = expect !== undefined && Math.abs(expect - pnl) < 0.005;
      this.result.append(
        h('span.k', 'Finished '),
        h(`b.${pnl >= 0 ? 'up' : 'down'}`, money(pnl * 100)),
        expect === undefined ? '' : same
          ? h('span.k', ' · same as the lab, to the cent')
          : h('span.warn', ` · the lab said ${money(expect * 100)}`));
    } else if (ended) {
      this.result.append(h('span.k', 'End of the recording'));
    }
    this.text();
  }

  /** Text readouts, a few times a second. */
  text(): void {
    const p = this.player;
    if (!p) return;
    setText(this.time, `${clockUs(p.cursor)} / ${clockUs(p.length)}`);
    this.track.setAttribute('aria-valuenow', String(Math.round(p.cursor / 1e6)));
    this.track.setAttribute('aria-valuetext', `${clockUs(p.cursor)} of ${clockUs(p.length)}`);
  }

  /** Every frame while replaying: apply any queued seek, then redraw. */
  frame(): void {
    const p = this.player;
    if (!p) return;
    if (this.pendingSeek >= 0) {
      const t = this.pendingSeek;
      this.pendingSeek = -1;
      p.seek(t);
    }
    this.draw();
  }

  private queueSeek(t: number): void {
    // Seeks coalesce to one per frame, so dragging stays smooth however fast
    // the pointer moves.
    this.pendingSeek = t;
  }

  private timeAt(clientX: number): number {
    const p = this.player!;
    const rect = this.canvas.getBoundingClientRect();
    return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * p.length;
  }

  private palette(): Palette {
    this.pal ??= {
      up: cssVar('--up'), down: cssVar('--down'), amber: cssVar('--amber'), cyan: cssVar('--cyan'), dim: cssVar('--dim'),
      faint: cssVar('--faint'), line: cssVar('--line'), text: cssVar('--text'), mono: cssVar('--mono'), sans: cssVar('--sans'),
    };
    return this.pal;
  }

  draw(): void {
    const p = this.player;
    if (!p || this.el.hidden) return;
    const { w, h: ht, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext('2d')!;
    const pal = this.palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);
    const len = Math.max(1, p.length);
    const x = (us: number) => (us / len) * w;
    const tickRow = 7; // bottom strip for action ticks
    const top = 3, bottom = ht - tickRow - 3;
    const playX = Math.round(x(p.cursor));

    // Baseline and the minute grid.
    ctx.fillStyle = pal.line;
    const minutes = len / 60e6;
    const every = [1, 2, 5, 10, 15, 30, 60].find((m) => (w / minutes) * m >= 48) ?? 60;
    for (let m = every; m < minutes; m += every) ctx.fillRect(Math.round(x(m * 60e6)), top, 1, bottom - top);

    const pv = p.preview;
    if (pv && pv.mid.length > 1) {
      const n = pv.mid.length;
      const xs = (i: number) => (Math.min(i * 1e6, len) / len) * w;
      // Price, scaled to the strip.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { lo = Math.min(lo, pv.mid[i]); hi = Math.max(hi, pv.mid[i]); }
      const pad = Math.max(1, (hi - lo) * 0.12);
      const py = (v: number) => bottom - ((v - lo + pad) / (hi - lo + 2 * pad)) * (bottom - top);
      ctx.strokeStyle = pal.dim;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const stride = Math.max(1, Math.floor(n / w));
      for (let i = 0; i < n; i += stride) (i ? ctx.lineTo(xs(i), py(pv.mid[i])) : ctx.moveTo(xs(i), py(pv.mid[i])));
      ctx.stroke();
      ctx.globalAlpha = 1;

      // P&L as an area around its own zero line, only if the account traded.
      let plo = 0, phi = 0;
      for (let i = 0; i < n; i++) { plo = Math.min(plo, pv.pnl[i]); phi = Math.max(phi, pv.pnl[i]); }
      if (phi - plo > 1) {
        const span = Math.max(phi, -plo) * 1.15;
        const mid = (top + bottom) / 2;
        const qy = (v: number) => mid - (v / span) * ((bottom - top) / 2);
        for (const [sign, color] of [[1, pal.up], [-1, pal.down]] as const) {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.2;
          ctx.beginPath();
          ctx.moveTo(0, mid);
          for (let i = 0; i < n; i += stride) ctx.lineTo(xs(i), qy(sign > 0 ? Math.max(0, pv.pnl[i]) : Math.min(0, pv.pnl[i])));
          ctx.lineTo(xs(n - 1), mid);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = pv.final >= 0 ? pal.up : pal.down;
        ctx.beginPath();
        for (let i = 0; i < n; i += stride) (i ? ctx.lineTo(xs(i), qy(pv.pnl[i])) : ctx.moveTo(xs(i), qy(pv.pnl[i])));
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = pal.faint;
      ctx.font = `10px ${pal.mono}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('Reading the session…', 6, (top + bottom) / 2);
    }

    // Scenario of a watched lab session.
    const watch = p.log.watch;
    if (watch && watch.scenario > 0) {
      const sx = Math.round(x(Math.round(watch.scenarioAt * watch.duration) * 1e6)) + 0.5;
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = pal.amber;
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, ht);
      ctx.stroke();
      ctx.restore();
    }

    // Action ticks along the bottom.
    for (const { t, a } of p.log.actions) {
      const color = tickOf(a, pal);
      if (!color || (a[0] === 'D' && t === 0)) continue;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x(t)), ht - tickRow, 2, tickRow - 1);
    }

    // What is still to come sits in shadow; what has played is lit.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(playX, 0, w - playX, ht);

    if (this.hoverX >= 0 && !this.dragging) {
      ctx.fillStyle = pal.faint;
      ctx.fillRect(Math.round(this.hoverX), 0, 1, ht);
      const label = clockUs((this.hoverX / w) * len);
      ctx.font = `10px ${pal.mono}`;
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width;
      const lx = clamp(this.hoverX + 5, 2, w - tw - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(lx - 3, 1, tw + 6, 13);
      ctx.fillStyle = pal.text;
      ctx.fillText(label, lx, 2);
    }

    // Playhead.
    ctx.fillStyle = pal.amber;
    ctx.fillRect(playX - 1, 0, 2, ht);
    ctx.beginPath();
    ctx.moveTo(playX - 4, 0);
    ctx.lineTo(playX + 4, 0);
    ctx.lineTo(playX, 5);
    ctx.closePath();
    ctx.fill();
  }
}
