# Tickforge

**A stock exchange that runs in your browser.** A limit order book and matching engine written in C++, compiled to WebAssembly, with about sixty simulated traders sending it orders. You trade against them, run a market-making bot, or try to make markets yourself for three minutes and get graded.

**[Open the live terminal](https://haneet10.github.io/Tickforge/)**

![The Tickforge terminal](docs/img/terminal.png)

Nothing on the screen is a recording or a random walk. Every candle is built from trades that the engine matched between simulated traders, and the price moves because of what they (and you) do.

## What you can do with it

| | |
|---|---|
| **Trade** | Limit, market and TWAP orders from the ticket, or click a price in the order book. The ticket shows your place in the queue and what crossing the spread will cost before you send. |
| **Break the market** | Trigger a flash crash, a news shock, a fat-finger order, a liquidity drought or a volatility storm and watch the book react. |
| **See who is on the other side** | X-ray mode shows the true value of the stock and which type of trader took each trade. A live table shows who is making money from whom. |
| **Run a market-making bot** | An Avellaneda-Stoikov quoting bot trades your account. A risk study replays it across 84 simulated sessions to show the trade-off between profit and risk. |
| **Take the challenge** | Three minutes as the market maker, trading blind, with news hitting at some point. You are scored against the bot playing the same market from the same seed. |

![A flash crash, and who paid for it](docs/img/flash-crash.png)

## The engine

The matching engine is about 2,400 lines of C++17 with no dependencies.

| Measure | Result |
|---|---|
| Throughput, native | 38 million order operations per second on one core |
| Latency, native | 26 ns mean, 56 ns median, 148 ns at the 99th percentile |
| Throughput, in the browser | 5 to 9 million simulated messages per second (shown live in the status bar) |
| WebAssembly module | 81 KB, no generated JavaScript glue |
| Tests | 37 tests, 3.9 million checks, run under AddressSanitizer and UndefinedBehaviorSanitizer |

How it gets there:

- **Flat price levels.** Prices are integer ticks, so a level is an array slot, not a tree node. Adding to a level is one index.
- **Three-level bitmap index.** The next non-empty price level is found with a few bit operations instead of a search.
- **Pooled orders with intrusive queues.** Orders live in one contiguous pool and link to their neighbours by index. Nothing is allocated while matching.
- **Generation-checked order ids.** An id encodes its pool slot, so cancel is a direct lookup with no hash map, and a stale id can never cancel the order that reused its slot.

Order types and rules: limit and market orders; good-till-cancelled, immediate-or-cancel and fill-or-kill; post-only; reduce in place without losing queue position; self-trade prevention; price-time priority throughout.

### How I know it is correct

The book is fuzzed against a second, deliberately simple implementation written for obviousness instead of speed. Both receive the same millions of random orders and cancels and must agree on every fill, every resting order and every best price. The market simulation is checked for conservation (shares and cash sum to zero across all accounts), for determinism (the same seed gives the same market, however time is sliced), and for an exact profit and loss breakdown.

## The market

No trader is told what the price should be. It emerges from six kinds of participant:

| Trader | Behaviour |
|---|---|
| Retail flow | Uninformed. Sends random limit and market orders and pays the spread. |
| Market makers (5) | Quote both sides, widen when volatility rises, lean their quotes against inventory, and pull out when they are being run over. |
| Momentum traders (3) | Chase recent moves. |
| Value traders (5) | Lean against the price when it strays from a noisy estimate of value. |
| Informed trader | Knows the true value and picks off stale quotes. |
| Institution | Appears in scenarios, working a large order with an execution algorithm. |

The stock's true value follows a mean-reverting process with changing volatility and occasional jumps. The exchange enforces price collars and an optional circuit breaker.

The result behaves like a real market in the ways that matter: spreads widen in stress, a large seller with no price limit causes a crash that recovers once slower capital arrives, and market makers earn the spread from uninformed flow and lose part of it to informed flow.

## Honest accounting

Your profit and loss is split exactly into three parts that always sum to the total: spread captured, inventory moves, and fees. Markouts show what the price did one, five and thirty seconds after each of your trades, which is how a trading desk tells whether the people it traded with knew more than it did.

![The market-making bot and its risk study](docs/img/bot.png)

## Build it yourself

Engine, tests and benchmark (needs CMake and a C++17 compiler):

```bash
cmake -S engine -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/tf_tests
./build/tf_bench
./build/tf_simulate 600 7 crash     # ten simulated minutes, seed 7, with a flash crash
```

The web terminal (needs Python and Node 20 or newer):

```bash
pip install ziglang==0.17.1        # the C++ to WebAssembly compiler
./scripts/build-wasm.sh
cd web && npm ci && npm run dev
```

## Layout

```
engine/include/tf   order book, price index, market, agents
engine/src          implementation
engine/wasm         the C interface the browser calls
engine/tests        unit tests, reference book, fuzzer, market tests
engine/bench        throughput and latency benchmark
engine/tools        headless simulator for the command line
web/src             the terminal: TypeScript and canvas, no framework
docs/DESIGN.md      design notes
```

More detail on the data structures, the simulation and the trade-offs is in [docs/DESIGN.md](docs/DESIGN.md).

## About

Built by Haneet Singh, Mechanical Engineering at the University of Waterloo.

Every price and trader here is simulated. This is not trading advice and uses no real market data.

Released under the [MIT License](LICENSE).
