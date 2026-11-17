# Design notes

These notes explain the decisions behind Tickforge: what each part does, why it is built that way, and what was traded away.

## 1. The order book

### Requirements

An order book has four hot operations: add an order, cancel an order, match an incoming order against resting ones, and report the best bid and offer. A real exchange sees far more adds and cancels than trades, so all four need to be constant time, and none should allocate memory.

### Layout

```
levels_[price]  ->  { head, tail, total quantity, order count }
pool_[slot]     ->  { id, next, prev, price, remaining, trader, side, live }
PriceIndex      ->  three levels of bitmaps over the price grid, one per side
```

**Prices are array indices.** A price is an integer number of ticks (one cent). The book holds 65,536 levels, which covers $0.01 to $655.35. Finding a level is `levels_[price]`. The alternative, a balanced tree keyed by price, costs a pointer chase per level and a cache miss on most of them.

**Orders are a pool with index links.** Each price level is a first-in, first-out queue threaded through the pool by 32-bit `next` and `prev` indices. Freed slots go on a free list and are reused. Matching never calls the allocator.

**The order id is the handle.** An id is `(sequence << 20) | slot`. Cancel reads the slot from the low bits and checks that the stored id matches. There is no hash map from id to order. If a slot has been reused, the stored id differs and the stale cancel is refused. This is tested directly.

**The next non-empty level comes from a bitmap.** `PriceIndex` keeps one bit per price level, one bit per 64 levels, and one bit per 4,096 levels. Finding the next occupied price above or below a given one is at most three word operations with count-trailing-zeros or count-leading-zeros. A sparse book (a flash crash leaves gaps of hundreds of ticks) costs the same as a dense one.

### Matching rules

- Price-time priority: best price first, then earliest arrival.
- Trades print at the resting order's price.
- Limit and market orders; good-till-cancelled, immediate-or-cancel, fill-or-kill.
- Post-only orders are rejected if they would trade.
- Reducing an order's size keeps its place in the queue.
- Self-trade prevention cancels the resting order when both sides belong to the same trader.

Fill-or-kill is checked before anything is touched, by walking the opposite side and summing available quantity, so a failed order leaves the book unchanged.

### Measured performance

`tf_bench` replays five million operations (about 45% adds, 45% cancels, 10% aggressive orders) against a book that stays a few thousand orders deep.

| | |
|---|---|
| Throughput | 38 million operations per second |
| Mean | 26 ns |
| Median | 56 ns including about 20 ns of timer overhead |
| 99th percentile | 148 ns |
| 99.9th percentile | 277 ns |

Single core, `-O2`, on a cloud virtual machine. Throughput is measured without per-operation timing; the percentiles are measured with it, which is why the median is above the mean.

### Trade-offs

- The price grid is fixed. A stock that left the $0.01 to $655.35 band would need a re-based grid. Real venues have the same constraint and solve it with per-symbol tick tables.
- The level array is about 1 MB per book. That is right for one symbol in a browser and would want a windowed array for thousands of symbols.
- The book is single threaded by design. Determinism matters more here than parallelism, and a matching engine is sequential per symbol on real exchanges too.

## 2. Testing

The tests use a small harness in `engine/tests/check.hpp` so the project has no dependencies.

**Reference model.** `reference_book.hpp` is a second order book written to be obviously correct: sorted maps of deques, linear scans, no cleverness. The fuzzer drives both books with the same random stream of orders and cancels across five market shapes (tight and busy, wide and sparse, constantly emptied, self-trading, deep) and compares every fill, every rejection, the best prices and the full depth after each step. A disagreement is a bug in one of them, and the simple one is easy to check by eye.

**Invariants.** `check_invariants()` walks the whole book and verifies that queue links are consistent, level totals match their orders, the bitmaps match the levels and the best prices are right. The fuzzer calls it throughout.

**Market properties.** The simulation is tested for the things that must hold whatever the agents do:

- The same seed produces the same market.
- The result does not depend on how the caller slices time.
- Shares sum to zero and cash sums to zero across all accounts.
- The user's profit and loss breakdown sums exactly to the total.
- A flash crash falls at least 3% and recovers most of it.
- The circuit breaker halts trading and trading resumes.

Everything runs under AddressSanitizer and UndefinedBehaviorSanitizer in continuous integration.

## 3. The market simulation

### Engine loop

The simulation is event driven. Each agent asks to be woken after some delay; wake-ups sit in a min-heap ordered by time. A housekeeping tick every 100 ms updates the fundamental value, volatility estimates and the user's statistics, and a bar closes every second. Each agent draws from its own random stream, derived from the seed, so adding an agent does not change what the others do.

### Fundamental value

The true value follows a mean-reverting (Ornstein-Uhlenbeck) process. Its volatility is itself random, with a 45 second half-life, and news arrives as occasional jumps. Only the informed trader sees this value. Everyone else infers it from the order flow.

### Agents

**Retail flow** is zero-intelligence: orders arrive as a Poisson process, with limit prices drawn from a power law around the touch. It is the uninformed flow that pays the spread.

**Market makers** keep an estimate of fair value and update it from signed taker volume, in the spirit of Kyle's lambda: buying pressure moves the estimate up. They quote around it, lean their quotes against inventory, widen when realised volatility rises, and stop quoting for a while when they are being run over. Five of them range from tight, fast and small to wide, slow and large.

**Momentum traders** follow the difference between a fast and a slow moving average, scaled by volatility.

**Value traders** trade toward a noisy private estimate of the true value. They are the slow capital that brings the price back after a dislocation.

**The informed trader** sees the true value and takes stale quotes when the price is far enough from it. Its rate is limited so that it earns a living without removing all liquidity.

**Execution algorithms** (TWAP, percentage of volume, sweep) work the user's parent orders and the institution's orders in scenarios.

### Why these choices

Early versions had market makers chase a moving average of order flow. Prices trended, market makers lost money and returns were positively autocorrelated, none of which matches real markets. Replacing that with a cumulative-flow estimate of fair value fixed all three. A second failure was a liquidity death spiral: one large order caused every market maker to pull out, permanently. Price collars at the exchange and a refractory period after a panic, both of which exist on real venues, fixed that.

### Exchange protections

- Limit orders more than 10% from the reference price are rejected.
- A single market order cannot trade more than 2% through the book.
- An optional circuit breaker halts trading for 30 seconds on a 3.5% move from a rolling two-minute reference.

### The flash crash

The flash crash scenario has an institution sell 32,000 shares as a fixed share of volume with no price limit. Volume rises as the price falls, so the algorithm sells faster into its own impact, and market makers withdraw. This is the mechanism identified in the joint regulatory report on 6 May 2010. The price recovers when value traders and the informed trader absorb the inventory.

## 4. The user's account

Profit and loss is decomposed at each fill:

```
spread    = (mid at the time of the trade - trade price) x signed quantity
inventory = position x change in mid, accumulated between events
fees      = taker fees paid minus maker rebates earned
total     = spread + inventory - fees
```

The identity holds exactly and is asserted in the tests.

**Markouts** record the mid one, five and thirty seconds after each fill, signed so that positive means the price moved in the user's favour. Persistently negative markouts on passive fills mean the user is being adversely selected.

**The quoting bot** implements Avellaneda and Stoikov (2008). It quotes around a reservation price `r = mid - q * gamma * sigma^2 * T` with half spread `gamma * sigma^2 * T / 2 + ln(1 + gamma / kappa) / gamma`, where `q` is inventory, `gamma` is risk aversion, `sigma` is the engine's volatility estimate and `kappa` describes how quickly fill probability falls with distance from the mid.

**The risk study** runs that bot through 12 seeds at each of 7 risk-aversion settings in a second engine instance off screen, and plots mean profit against its standard deviation. It finishes in a couple of seconds because the engine simulates a ten-minute session in a few milliseconds.

## 5. WebAssembly and the terminal

The engine is compiled with clang (through zig's toolchain) to a standalone `wasm32-wasi` reactor module. There is no Emscripten runtime and no generated glue. The browser calls about thirty plain C functions; bulk data (depth, bars, tape, fills) is copied into buffers that JavaScript reads as typed arrays. The module is 81 KB.

The terminal is TypeScript with no framework. The chart and depth views are drawn on canvas every animation frame; tables update at about 12 Hz and only touch the DOM when a value changes. One frame of engine work at 64 times real speed takes about 0.2 ms, which leaves the whole frame budget for drawing.

On load the page simulates 45 minutes of trading so that the chart opens with history. That takes about 50 ms.

## 6. What this is not

Tickforge is a simulation. The agents are simple models, not calibrated to any real stock, and the results are not evidence that any strategy would make money in a real market. Its purpose is to show the mechanics of a limit order market accurately and to make them visible.

## References

- Avellaneda, M. and Stoikov, S. (2008). High-frequency trading in a limit order book. *Quantitative Finance* 8(3).
- Kyle, A. S. (1985). Continuous auctions and insider trading. *Econometrica* 53(6).
- Glosten, L. R. and Milgrom, P. R. (1985). Bid, ask and transaction prices in a specialist market with heterogeneously informed traders. *Journal of Financial Economics* 14(1).
- Gode, D. K. and Sunder, S. (1993). Allocative efficiency of markets with zero-intelligence traders. *Journal of Political Economy* 101(1).
- U.S. CFTC and SEC (2010). Findings regarding the market events of May 6, 2010.
