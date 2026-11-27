// Runs backtests off the main thread so the terminal keeps gliding while a
// batch of sessions is simulated. One engine instance, reused for every run.
import { Engine, type BacktestSpec } from '../engine';

export type LabRequest = { type: 'run'; batch: number; jobs: BacktestSpec[] };
export type LabReply =
  | { type: 'ready'; catalog: ReturnType<Engine['catalog']> }
  | { type: 'result'; batch: number; index: number; run: ReturnType<Engine['backtest']>; ms: number }
  | { type: 'done'; batch: number; ms: number }
  | { type: 'error'; message: string };

const post = (msg: LabReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let current = 0;
const queue: LabRequest[] = [];
let engine: Engine | null = null;

let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length && engine) {
    const req = queue.shift()!;
    if (req.batch !== current) continue;
    const t0 = performance.now();
    for (let i = 0; i < req.jobs.length; i++) {
      // Let a newer batch (or a cancel) in between runs.
      await new Promise((r) => setTimeout(r));
      if (req.batch !== current) break;
      const s = performance.now();
      const run = engine.backtest(req.jobs[i]);
      post({ type: 'result', batch: req.batch, index: i, run, ms: performance.now() - s }, [run.equity.buffer]);
    }
    if (req.batch === current) post({ type: 'done', batch: req.batch, ms: performance.now() - t0 });
  }
  running = false;
}

self.onmessage = (e: MessageEvent<LabRequest | { type: 'cancel'; batch: number }>) => {
  current = e.data.batch;
  if (e.data.type === 'run') {
    queue.push(e.data);
    void pump();
  }
};

Engine.create(1)
  .then((eng) => {
    engine = eng;
    post({ type: 'ready', catalog: eng.catalog() });
    void pump();
  })
  .catch((err) => post({ type: 'error', message: String(err) }));
