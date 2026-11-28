// "Replay" in the top bar: shows what the live recording holds, gives a link
// that replays it anywhere, and can play it back right here.
import type { App } from '../app';
import { h } from '../dom';
import { openModal } from '../ui/overlays';
import { clockUs, orderCount, shareUrl, type SessionLog } from './log';

export async function openShare(app: App, watch: (log: SessionLog) => void): Promise<void> {
  const log = app.currentLog();
  const url = await shareUrl(log);
  const orders = orderCount(log);
  const other = log.actions.length - orders - (log.actions[0]?.a[0] === 'D' && log.actions[0].t === 0 ? 1 : 0);

  const input = h('input.share-url', { type: 'text', readonly: true, value: url, 'aria-label': 'Replay link', spellcheck: 'false' });
  const copyBtn = h('button.btn.share-copy', { type: 'button' }, 'Copy link');
  const note = h('span.share-note', { 'aria-live': 'polite' }, `${url.length.toLocaleString()} characters`);
  copyBtn.addEventListener('click', async () => {
    input.select();
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = document.execCommand?.('copy') ?? false;
    }
    note.textContent = ok ? 'Copied. Anyone who opens it watches this exact market.' : 'Select the link and copy it.';
    copyBtn.textContent = ok ? 'Copied' : 'Copy link';
  });
  input.addEventListener('focus', () => input.select());

  const fact = (k: string, v: string) => h('div.share-fact', h('span.k', k), h('span.v', v));
  openModal({
    title: 'Replay this session',
    body: [
      h('p', 'Everything you have done in this market is being recorded: not a video, just the seed and each action with the microsecond it happened. The engine is deterministic, so replaying them rebuilds the same market, tick for tick.'),
      h('div.share-facts',
        fact('Session', clockUs(log.length)),
        fact('Orders', String(orders)),
        fact('Other actions', String(Math.max(0, other))),
        fact('Seed', String(log.seed))),
      h('div.share-row', input, copyBtn),
      note,
    ],
    actions: [
      { label: 'Close' },
      { label: 'Watch from the start', solid: true, run: () => watch(log) },
    ],
  });
}
