// Number formatting. Prices arrive in ticks; everything shown is in dollars.
import { TICK } from './engine';

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Price in ticks to "100.25". */
export function px(ticks: number): string {
  return two.format(ticks * TICK);
}

export function qty(n: number): string {
  return int.format(Math.round(n));
}

/** Compact quantity: 1,234 -> 1.2K, 3,400,000 -> 3.40M. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return int.format(Math.round(n));
}

/** Money from ticks x shares, with sign: "+$12.40" / "−$3.10". */
export function money(ticks: number, sign = true): string {
  const d = ticks * TICK;
  const body = '$' + two.format(Math.abs(d));
  if (!sign) return (d < -0.004 ? '−' : '') + body;
  if (d > 0.004) return '+' + body;
  if (d < -0.004) return '−' + body;
  return body;
}

export function signed(n: number, digits = 0): string {
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n > 0) return '+' + body;
  if (n < 0) return '−' + body;
  return body;
}

export function pct(fraction: number, digits = 2): string {
  const v = fraction * 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits) + '%';
}

/** Up / down / flat class for a signed number. */
export function tone(n: number, eps = 1e-9): 'up' | 'down' | 'flat' {
  return n > eps ? 'up' : n < -eps ? 'down' : 'flat';
}

const OPEN_SECONDS = 9 * 3600 + 30 * 60; // the simulated session opens at 09:30:00

/** Simulated seconds since the open to wall-clock "10:15:42". */
export function clock(seconds: number): string {
  const t = Math.floor(seconds) + OPEN_SECONDS;
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function clockShort(seconds: number): string {
  return clock(seconds).slice(0, 5);
}
