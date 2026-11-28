// A recorded session: the seed, the warm-up and every action that changed the
// market, each stamped with the simulated microsecond it happened.
//
// The engine is deterministic and does not care how time is sliced, so this
// small log is the whole session. Replaying it re-simulates the market from
// the seed and lands each action on its original microsecond; the order book,
// every candle and every fill come out identical. A ten-minute session with a
// few dozen trades fits in a link of a few hundred characters.

/** Every action that changes the market, as compact tuples. */
export type Action =
  | ['L', side: number, price: number, qty: number, tif: number, postOnly: number] // limit order
  | ['M', side: number, qty: number] // market order
  | ['X', id: number] // cancel one order
  | ['XA'] // cancel all
  | ['F'] // flatten
  | ['T', side: number, qty: number, seconds: number] // TWAP
  | ['AX'] // stop the algo
  | ['R'] // reset the account
  | ['B', on: number, gamma: number, kappa: number, horizon: number, size: number, maxInventory: number] // quoting bot
  | ['S', scenario: number] // scenario, index into SCENARIOS
  | ['D', activity: number, liquidity: number, volatility: number, momentum: number, informed: number, breaker: number] // dials
  | ['N', fraction: number]; // news (the challenge's surprise)

export type Code = Action[0];

/** An action and when it happened, in microseconds after the session began. */
export interface Stamped {
  t: number;
  a: Action;
}

/** A lab session to watch: the strategy trades the account, nobody else does. */
export interface WatchSpec {
  strategy: number;
  params: number[];
  duration: number; // seconds
  scenario: number; // BACKTEST_SCENARIOS index
  scenarioAt: number; // fraction of the session
  /** The P&L the lab reported, in dollars, to show the replay matches. */
  expect?: number;
  label?: string;
}

export interface SessionLog {
  seed: number;
  warmup: number; // seconds of market before the session began
  length: number; // microseconds recorded
  actions: Stamped[];
  watch?: WatchSpec;
}

/** Fields per action code, after the code itself. */
const ARITY: Record<Code, number> = { L: 5, M: 2, X: 1, XA: 0, F: 0, T: 3, AX: 0, R: 0, B: 6, S: 1, D: 6, N: 1 };

export const VERSION = 1;
/** Hard limits that keep a hostile link from asking for hours of simulation. */
export const MAX_LENGTH_US = 4 * 3600 * 1e6;
export const MAX_ACTIONS = 20000;

export class LogError extends Error {}

export function emptyLog(seed: number, warmup: number): SessionLog {
  return { seed, warmup, length: 0, actions: [] };
}

/** The actions at or before `t`, as a new log that ends there (for "take over"). */
export function truncate(log: SessionLog, t: number): SessionLog {
  return { ...log, length: Math.max(0, Math.round(t)), actions: log.actions.filter((x) => x.t <= t) };
}

/** Counts the actions a person would call trades: orders sent. */
export function orderCount(log: SessionLog): number {
  return log.actions.reduce((n, x) => n + (x.a[0] === 'L' || x.a[0] === 'M' || x.a[0] === 'T' ? 1 : 0), 0);
}

// -------------------------------------------------------------- wire ----
//
// JSON with times as deltas (they are mostly small), deflated and base64url
// encoded so it survives in a URL fragment. Browsers without
// CompressionStream fall back to plain base64 JSON, flagged by the first char.

interface Wire {
  v: number;
  s: number;
  w: number;
  n: number;
  a: (number | string)[][];
  st?: [number, number, number, number, number[], number | null, string | null];
}

export function toWire(log: SessionLog): Wire {
  let prev = 0;
  const a = log.actions.map(({ t, a }) => {
    const dt = t - prev;
    prev = t;
    return [dt, ...a];
  });
  const wire: Wire = { v: VERSION, s: log.seed, w: log.warmup, n: log.length, a };
  if (log.watch) {
    const w = log.watch;
    wire.st = [w.strategy, w.duration, w.scenario, w.scenarioAt, w.params, w.expect ?? null, w.label ?? null];
  }
  return wire;
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function fromWire(raw: unknown): SessionLog {
  if (!raw || typeof raw !== 'object') throw new LogError('This link does not contain a session.');
  const w = raw as Partial<Wire>;
  if (w.v !== VERSION) throw new LogError('This session was recorded by a different version of Tickforge.');
  if (!isInt(w.s) || w.s < 1 || w.s > 2 ** 31) throw new LogError('The session has an invalid seed.');
  if (!isNum(w.w) || w.w < 0 || w.w > 7200) throw new LogError('The session has an invalid warm-up.');
  if (!isInt(w.n) || w.n < 0 || w.n > MAX_LENGTH_US) throw new LogError('The session is too long to replay.');
  if (!Array.isArray(w.a) || w.a.length > MAX_ACTIONS) throw new LogError('The session has too many actions.');
  let t = 0;
  const actions: Stamped[] = w.a.map((row, i) => {
    if (!Array.isArray(row) || !isInt(row[0]) || row[0] < 0) throw new LogError(`Action ${i + 1} is damaged.`);
    const code = row[1] as Code;
    const arity = ARITY[code];
    if (arity === undefined || row.length !== arity + 2 || !row.slice(2).every(isNum)) {
      throw new LogError(`Action ${i + 1} is damaged.`);
    }
    t += row[0];
    return { t, a: row.slice(1) as Action };
  });
  if (t > w.n) throw new LogError('The session ends before its last action.');
  const log: SessionLog = { seed: w.s, warmup: w.w, length: w.n, actions };
  if (w.st) {
    const [strategy, duration, scenario, scenarioAt, params, expect, label] = w.st;
    if (!isInt(strategy) || !isNum(duration) || !isInt(scenario) || !isNum(scenarioAt) ||
        !Array.isArray(params) || !params.every(isNum) || params.length > 5) {
      throw new LogError('The strategy in this session is damaged.');
    }
    log.watch = { strategy, duration, scenario, scenarioAt, params };
    if (isNum(expect)) log.watch.expect = expect;
    if (typeof label === 'string') log.watch.label = label.slice(0, 80);
  }
  return log;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Encodes a log for a URL fragment. 'z' prefix: deflated; 'j': plain JSON. */
export async function encode(log: SessionLog): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(toWire(log)));
  if (canCompress()) {
    try {
      return 'z' + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
    } catch {
      /* fall through to plain */
    }
  }
  return 'j' + toBase64Url(json);
}

export async function decode(text: string): Promise<SessionLog> {
  const kind = text[0];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.slice(1));
  } catch {
    throw new LogError('This replay link is damaged. Check that it was copied in full.');
  }
  if (kind === 'z') {
    if (!canCompress()) throw new LogError('This browser cannot open compressed replay links.');
    try {
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } catch {
      throw new LogError('This replay link is damaged. Check that it was copied in full.');
    }
  } else if (kind !== 'j') {
    throw new LogError('This is not a Tickforge replay link.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LogError('This replay link is damaged. Check that it was copied in full.');
  }
  return fromWire(raw);
}

/** The shareable URL for a log, relative to the current page. */
export async function shareUrl(log: SessionLog, base = location.href): Promise<string> {
  const url = new URL(base);
  url.search = '';
  url.hash = `replay=${await encode(log)}`;
  return url.toString();
}

/** Formats microseconds of session time as m:ss. */
export function clockUs(us: number): string {
  const s = Math.max(0, Math.floor(us / 1e6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
