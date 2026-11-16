// A few DOM helpers. The UI is plain DOM and canvas: no framework.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: any) => void) | undefined>;

/** Create an element: h('button.btn.primary', { type: 'button' }, 'Buy'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attrs?: Attrs | Child,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs as Child);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

/** Set text only when it changed, to avoid needless layout work at 60 fps. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setClass(el: HTMLElement, base: string, tone: string): void {
  const cls = tone ? `${base} ${tone}` : base;
  if (el.className !== cls) el.className = cls;
}

/** Size a canvas for the device pixel ratio. Returns true if it changed. */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number; changed: boolean } {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const hgt = Math.max(1, Math.round(rect.height));
  const bw = Math.round(w * dpr);
  const bh = Math.round(hgt * dpr);
  const changed = canvas.width !== bw || canvas.height !== bh;
  if (changed) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h: hgt, dpr, changed };
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
