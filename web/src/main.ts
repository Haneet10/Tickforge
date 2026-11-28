// Entry point: boot the engine, build the panels, run the frame loop.
import './style.css';
import { App, SCENARIOS } from './app';
import { $, h, setText } from './dom';
import { clock, compact, pct, px, qty, signed } from './fmt';
import { Chart } from './ui/chart';
import { Depth } from './ui/depth';
import { Dock } from './ui/dock';
import { Ladder } from './ui/ladder';
import { Challenge, mountToasts, openAbout, Tour } from './ui/overlays';
import { Tape } from './ui/tape';
import { TrendTone } from './ui/motion';
import { Ticket } from './ui/ticket';
import { Lab } from './lab/lab';
import { ReplayBar } from './replay/bar';
import { decode, LogError, type SessionLog } from './replay/log';
import { Player } from './replay/player';
import { openShare } from './replay/share';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seed = Math.max(1, Math.floor(Number(params.get('seed'))) || 2010);
  const app = new App();
  (window as any).tickforge = app; // handy in the console

  try {
    await Promise.all([app.boot(seed), document.fonts?.ready]);
  } catch (err) {
    setText($('boot-msg'), 'The engine could not start. This browser may not support WebAssembly.');
    console.error(err);
    return;
  }

  $('app').hidden = false;
  app.setXray(true);

  const chart = new Chart(app, $<HTMLCanvasElement>('chart'), $('chart-legend'), $('btn-live'));
  (window as any).tickforgeChart = chart; // for the smoothness checks in the browser console
  const ticket = new Ticket(app);
  const ladder = new Ladder(app, () => ticket.qty() || 100);
  const depth = new Depth(app, $<HTMLCanvasElement>('depth'), $('depth-legend'));
  const tape = new Tape(app);
  const dock = new Dock(app);
  const tour = new Tour(app);
  const challenge = new Challenge(app, {
    armLadder: (on) => ladder.setArmed(on),
    showAccount: () => dock.show('account'),
  });
  mountToasts(app);

  // ------------------------------------------------------------ top bar ----
  const speedBtns = [...document.querySelectorAll<HTMLButtonElement>('.speed .seg')];
  const pauseBtn = $('btn-pause');
  const pauseIcon = document.getElementById('pause-icon')!;
  const syncSpeed = () => {
    for (const b of speedBtns) b.setAttribute('aria-pressed', String(!app.paused && Number(b.dataset.speed) === app.speed));
    pauseBtn.classList.toggle('paused', app.paused);
    pauseIcon.setAttribute('d', app.paused ? 'M4 3l9 5-9 5z' : 'M4 3h3v10H4zM9 3h3v10H9z');
    pauseBtn.setAttribute('aria-label', app.paused ? 'Resume the market' : 'Pause the market');
  };
  for (const b of speedBtns)
    b.addEventListener('click', () => {
      if (app.challengeActive && Number(b.dataset.speed) > 2) return app.toast('Speed is capped during the challenge', 'warn');
      app.setSpeed(Number(b.dataset.speed));
    });
  pauseBtn.addEventListener('click', () => {
    if (app.challengeActive) return app.toast('No pausing during the challenge', 'warn');
    app.togglePause();
  });
  app.on('speed', syncSpeed);
  syncSpeed();

  const xrayBtn = $('btn-xray');
  xrayBtn.addEventListener('click', () => app.setXray(!app.xray));
  app.on('xray', () => xrayBtn.setAttribute('aria-pressed', String(app.xray)));

  const tfBtns = [...document.querySelectorAll<HTMLButtonElement>('#tf-group .seg')];
  const syncTf = () => tfBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.tf) === chart.tf)));
  for (const b of tfBtns) b.addEventListener('click', () => { chart.setTf(Number(b.dataset.tf)); syncTf(); });
  syncTf();
  $<HTMLInputElement>('ov-vwap').addEventListener('change', (e) => (chart.showVwap = (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('ov-value').addEventListener('change', (e) => (chart.showValue = (e.target as HTMLInputElement).checked));

  // Scenarios menu.
  const menu = $('menu-scenarios');
  const menuBtn = $('btn-scenarios');
  for (const sc of SCENARIOS)
    menu.append(h(`button.scen.${sc.tone}`, { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); app.runScenario(sc.id); } },
      h('span.name', sc.name), h('span.blurb', sc.blurb)));
  const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (app.challengeActive) return app.toast('Scenarios are locked during the challenge', 'warn');
    if (!menu.hidden) return closeMenu();
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    const r = menuBtn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.maxHeight = `${window.innerHeight - r.bottom - 16}px`;
    menu.style.overflowY = 'auto';
    (menu.firstElementChild as HTMLElement).focus();
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== menuBtn) closeMenu(); });

  $('btn-challenge').addEventListener('click', () => (app.driver ? app.driver.refuse() : challenge.intro()));

  // ------------------------------------------------------------ replays ----
  // A replay takes over the clock; the whole terminal follows it. Leaving puts
  // back the live session exactly where it was, by re-simulating its log.
  let player: Player | null = null;
  const bar = new ReplayBar(app, () => exitReplay());
  $('app').insertBefore(bar.el, document.querySelector('.statusbar'));
  const clearHash = () => {
    if (location.hash.startsWith('#replay=')) history.replaceState(null, '', location.pathname + location.search);
  };
  const enterReplay = (log: SessionLog) => {
    if (app.challengeActive) return app.toast('Finish the challenge first', 'warn');
    const restore = player ? player.restore : app.currentLog();
    player = new Player(app, log, restore, {
      onChange: () => bar.sync(),
      onEnd: (result) => {
        if (result && log.watch?.expect !== undefined) {
          const same = Math.abs(result.pnl - log.watch.expect) < 0.005;
          app.toast(same ? 'Session over. Same P&L as the lab, to the cent.' : 'Session over, but the P&L differs from the lab. Please report this.', same ? 'up' : 'warn');
        }
      },
    });
    bar.attach(player);
    player.start();
    if (app.paused) app.togglePause();
    bar.sync();
  };
  const exitReplay = () => {
    if (!player) return;
    player.exit();
  };
  app.on('replay', () => {
    if (app.driver) return;
    const tookOver = player?.tookOver ?? false;
    player = null;
    bar.attach(null);
    clearHash();
    if (tookOver) app.toast('The market is yours from here. Recording carries on.', 'info');
  });
  app.on('speed', () => bar.sync());
  const openFromHash = async () => {
    if (!location.hash.startsWith('#replay=')) return;
    try {
      const log = await decode(location.hash.slice('#replay='.length));
      enterReplay(log);
    } catch (err) {
      clearHash();
      app.toast(err instanceof LogError ? err.message : 'This replay link could not be opened.', 'warn');
      if (!(err instanceof LogError)) console.error(err);
    }
  };

  // Strategy lab: a full-screen view over the terminal, also reachable at #lab.
  const appEl = $('app');
  const labBtn = $('btn-lab');
  const lab = new Lab(() => {
    appEl.inert = false;
    labBtn.focus({ preventScroll: true });
  }, (log) => {
    lab.close();
    enterReplay(log);
  });
  const openLab = () => {
    if (app.challengeActive) return app.toast('The lab is closed during the challenge', 'warn');
    appEl.inert = true;
    lab.open();
  };
  labBtn.addEventListener('click', openLab);
  window.addEventListener('hashchange', () => {
    if (location.hash === '#lab') openLab();
    else if (location.hash.startsWith('#replay=')) void openFromHash();
    else lab.close();
  });
  if (location.hash === '#lab') openLab();
  $('btn-replay').addEventListener('click', () => {
    if (player) return app.toast('Exit this replay first, then share your own session.', 'info');
    if (app.challengeActive) return app.toast('You can replay the challenge when it is over', 'warn');
    void openShare(app, (log) => enterReplay(log));
  });
  $('btn-tour').addEventListener('click', () => tour.start());
  $('btn-about').addEventListener('click', () => openAbout(app));

  // Keyboard.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.scrim, .tour-card') || lab.isOpen) return;
    if (e.key === 'Escape' && player && menu.hidden) { exitReplay(); return; }
    if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === 'f' || e.key === 'F') app.flatten();
    else if (e.key === 'c' || e.key === 'C') app.cancelAll();
    else if (e.key === 'x' || e.key === 'X') { if (!app.challengeActive) app.setXray(!app.xray); }
    else if (e.key >= '1' && e.key <= '4') speedBtns[Number(e.key) - 1]?.click();
  });

  // --------------------------------------------------------------- loop ----
  const el = {
    last: $('q-last'), chg: $('q-chg'), bid: $('s-bid'), ask: $('s-ask'), spread: $('s-spread'), vol: $('s-vol'),
    vwap: $('s-vwap'), high: $('s-high'), low: $('s-low'), sigma: $('s-sigma'), clock: $('clock'),
    engine: $('st-engine'), rate: $('st-rate'), book: $('st-book'), seed: $('st-seed'), halt: $('halt-banner'),
  };
  // Colour the last price by its trend, not by every bid-ask bounce.
  const lastTone = new TrendTone(3);
  app.on('restart', () => lastTone.reset());
  let msgMark = { time: 0, messages: 0, rate: 0 };

  const slowUi = () => {
    const s = app.s;
    setText(el.last, px(s.last));
    const lastCls = `q-last ${lastTone.push(s.last)}`;
    if (el.last.className !== lastCls) el.last.className = lastCls;
    const change = s.last - s.open;
    setText(el.chg, `${signed(change / 100, 2)}  ${pct(change / s.open)}`);
    el.chg.className = `q-chg ${change >= 0 ? 'up' : 'down'}`;
    setText(el.bid, s.bid ? `${px(s.bid)} × ${compact(s.bidQty)}` : '—');
    setText(el.ask, s.ask ? `${px(s.ask)} × ${compact(s.askQty)}` : '—');
    setText(el.spread, s.bid && s.ask ? `${s.ask - s.bid} tick${s.ask - s.bid === 1 ? "" : "s"}` : "—");
    setText(el.vol, compact(s.volume));
    setText(el.vwap, px(s.vwap));
    setText(el.high, px(s.high));
    setText(el.low, px(s.low));
    // Per-second tick volatility to an annualised percentage (6.5 hour day, 252 days).
    setText(el.sigma, `${((s.sigma / s.mid) * Math.sqrt(23400 * 252) * 100).toFixed(0)}%`);
    setText(el.clock, clock(s.time));

    if (s.time - msgMark.time >= 1) {
      msgMark = { time: s.time, messages: s.messages, rate: (s.messages - msgMark.messages) / (s.time - msgMark.time) };
    }
    const w = app.warmup;
    setText(el.engine, `C++ engine in WebAssembly · ${((w.messages / Math.max(1, w.ms)) / 1000).toFixed(1)}M msg/s at start-up`);
    setText(el.rate, `${msgMark.rate.toFixed(0)} msg/s now · ${compact(s.messages)} total`);
    setText(el.book, `${qty(s.liveOrders)} resting orders`);
    setText(el.seed, `seed ${app.engine.seed}`);

    el.halt.hidden = s.haltRemaining <= 0;
    if (s.haltRemaining > 0) setText(el.halt, `Trading halted · resumes in ${Math.ceil(s.haltRemaining)}s`);

    bar.text();
    ladder.update();
    tape.update();
    ticket.refresh();
    dock.update();
  };

  let prev = performance.now();
  let slowAt = 0;
  const frame = (now: number) => {
    const dt = (now - prev) / 1000;
    prev = now;
    app.frame(dt);
    challenge.update();
    bar.frame();
    chart.draw();
    depth.draw();
    // Numbers and tables refresh five times a second: fast enough to feel live,
    // slow enough to read. The canvases above glide every frame.
    if (now - slowAt > 200) {
      slowAt = now;
      slowUi();
    }
    requestAnimationFrame(frame);
  };
  slowUi();
  requestAnimationFrame(frame);
  // Keep the market moving, slowly, when the tab is in the background.
  document.addEventListener('visibilitychange', () => (prev = performance.now()));

  const boot = $('boot');
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 400);

  let toured = false;
  try { toured = localStorage.getItem('tickforge.toured') === '1'; } catch { /* private mode */ }
  const replayLink = location.hash.startsWith('#replay=');
  if (replayLink) void openFromHash();
  if (!toured && !replayLink && !params.has('notour') && !lab.isOpen && window.innerWidth > 900) setTimeout(() => tour.start(), 900);
}

main();
