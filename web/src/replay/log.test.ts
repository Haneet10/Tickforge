import { describe, expect, it } from 'vitest';
import type { Engine } from '../engine';
import { applyToEngine, SCENARIO_RUNS } from './apply';
import { SCENARIOS } from '../app';
import {
  type Action, clockUs, decode, encode, fromWire, LogError, MAX_LENGTH_US, orderCount, type SessionLog, shareUrl, toWire, truncate,
} from './log';

const b64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sample: SessionLog = {
  seed: 2010,
  warmup: 2700,
  length: 95_250_000,
  actions: [
    { t: 0, a: ['D', 1, 1, 1, 1, 1, 0] },
    { t: 4_120_337, a: ['M', 0, 300] },
    { t: 9_000_001, a: ['L', 1, 10012, 200, 0, 1] },
    { t: 9_000_001, a: ['X', 17] }, // two actions in the same microsecond keep their order
    { t: 30_500_000, a: ['S', 1] },
    { t: 41_000_000, a: ['B', 1, 0.05, 0.7, 10, 100, 1000] },
    { t: 60_000_000, a: ['T', 0, 5000, 60] },
    { t: 61_000_000, a: ['AX'] },
    { t: 70_000_000, a: ['XA'] },
    { t: 80_000_000, a: ['F'] },
    { t: 81_000_000, a: ['R'] },
    { t: 90_000_000, a: ['N', -0.012] },
  ],
};

describe('session log wire format', () => {
  it('round-trips through the URL encoding exactly', async () => {
    const text = await encode(sample);
    expect(text[0]).toBe('z'); // Node has CompressionStream, so it deflates
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/); // safe in a URL fragment
    expect(await decode(text)).toEqual(sample);
  });

  it('stores times as deltas so long sessions stay short', () => {
    const wire = toWire(sample);
    expect(wire.a[1][0]).toBe(4_120_337);
    expect(wire.a[2][0]).toBe(9_000_001 - 4_120_337);
    expect(wire.a[3][0]).toBe(0);
    expect(fromWire(wire).actions.map((x) => x.t)).toEqual(sample.actions.map((x) => x.t));
  });

  it('keeps a watched lab session, its expected P&L and label', async () => {
    const watch: SessionLog = {
      seed: 1017, warmup: 300, length: 600e6, actions: [],
      watch: { strategy: 0, params: [0.1, 1.5, 30, 200, 1000], duration: 600, scenario: 1, scenarioAt: 0.4, expect: 23.24, label: 'Avellaneda-Stoikov maker · session 1017' },
    };
    expect(await decode(await encode(watch))).toEqual(watch);
  });

  it('decodes the plain fallback used by browsers without CompressionStream', async () => {
    const json = JSON.stringify(toWire(sample));
    expect(await decode('j' + b64url(json))).toEqual(sample);
  });

  it('a ten-minute session with 40 orders fits in a short link', async () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({ t: 1_000_000 + i * 14_870_123, a: ['L', i % 2, 10000 + i, 100, 0, 0] as Action }));
    const url = await shareUrl({ seed: 7, warmup: 2700, length: 600e6, actions }, 'https://haneet10.github.io/Tickforge/?seed=7');
    expect(url.startsWith('https://haneet10.github.io/Tickforge/#replay=z')).toBe(true);
    expect(url).not.toContain('?seed');
    expect(url.length).toBeLessThan(700);
  });
});

describe('damaged and hostile links', () => {
  const wire = () => JSON.parse(JSON.stringify(toWire(sample)));
  const bad = (mutate: (w: any) => void) => {
    const w = wire();
    mutate(w);
    return () => fromWire(w);
  };

  it('rejects other versions, bad seeds and impossible lengths', () => {
    expect(bad((w) => (w.v = 2))).toThrow(/different version/);
    expect(bad((w) => (w.s = 0))).toThrow(LogError);
    expect(bad((w) => (w.s = 1.5))).toThrow(LogError);
    expect(bad((w) => (w.n = MAX_LENGTH_US + 1))).toThrow(/too long/);
    expect(bad((w) => (w.n = 1))).toThrow(/ends before its last action/);
  });

  it('rejects unknown codes, wrong arity and non-numbers', () => {
    expect(bad((w) => (w.a[1][1] = 'Q'))).toThrow(/Action 2 is damaged/);
    expect(bad((w) => w.a[1].push(1))).toThrow(/Action 2 is damaged/);
    expect(bad((w) => (w.a[2][3] = '10012'))).toThrow(/Action 3 is damaged/);
    expect(bad((w) => (w.a[2][0] = -5))).toThrow(/Action 3 is damaged/);
    expect(bad((w) => (w.a[2][3] = Infinity))).toThrow(LogError);
  });

  it('turns garbage into a readable error, never an exception from deep inside', async () => {
    await expect(decode('x123')).rejects.toThrow(/not a Tickforge replay link/);
    await expect(decode('zAAAA')).rejects.toThrow(/damaged/);
    await expect(decode('j' + b64url('{"v":1'))).rejects.toThrow(/damaged/);
    await expect(decode('j!!!')).rejects.toThrow(LogError);
  });
});

describe('log helpers', () => {
  it('truncates at a moment, keeping actions at exactly that microsecond', () => {
    const t = truncate(sample, 9_000_001);
    expect(t.length).toBe(9_000_001);
    expect(t.actions.map((x) => x.a[0])).toEqual(['D', 'M', 'L', 'X']);
    expect(sample.actions.length).toBe(12); // the original is untouched
  });

  it('counts orders, not settings', () => {
    expect(orderCount(sample)).toBe(3); // M, L, T
  });

  it('formats session time', () => {
    expect(clockUs(0)).toBe('0:00');
    expect(clockUs(61_999_999)).toBe('1:01');
    expect(clockUs(3_725e6)).toBe('1:02:05');
  });
});

describe('applying actions', () => {
  it('maps every action to exactly one engine call with its arguments', () => {
    const calls: string[] = [];
    const engine = new Proxy({}, {
      get: (_t, name: string) => (...args: unknown[]) => {
        calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
        return { id: 1, status: 0, reject: 0, filled: 0, resting: 0, avgPrice: 0 };
      },
    }) as unknown as Engine;
    for (const { a } of sample.actions) applyToEngine(engine, a);
    expect(calls).toEqual([
      'dials(1,1,1,true,true)', 'breaker(false,0.035)',
      'market(0,300)',
      'limit(1,10012,200,0,true)',
      'cancel(17)',
      'news(-0.02)',
      'bot(true,{"gamma":0.05,"kappa":0.7,"horizon":10,"size":100,"maxInventory":1000})',
      'algo(0,5000,0,60)',
      'algoCancel()',
      'cancelAll()',
      'flatten()',
      'userReset()',
      'news(-0.012)',
    ]);
  });

  it('has one engine scenario for every entry in the menu, in the same order', () => {
    expect(SCENARIO_RUNS.length).toBe(SCENARIOS.length);
    const calls: string[] = [];
    const engine = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => calls.push(`${name}(${args.join(',')})`) }) as unknown as Engine;
    SCENARIO_RUNS.forEach((run) => run(engine));
    expect(calls).toEqual(['crash(1)', 'news(-0.02)', 'news(0.02)', 'whale(0,25000,90)', 'fatFinger(1,15000)', 'drought(60)', 'volBurst(120,3)']);
    expect(SCENARIOS.map((s) => s.id)).toEqual(['crash', 'news-bad', 'news-good', 'whale', 'fat-finger', 'drought', 'storm']);
  });
});
