// Matching-engine benchmark.
//
// Replays a pre-generated stream of orders against the book and reports
// throughput and per-operation latency. The stream is built before the clock
// starts, so only the engine is measured.
//
//   tf_bench [operations]
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "tf/order_book.hpp"
#include "tf/rng.hpp"

using namespace tf;
using Clock = std::chrono::steady_clock;

namespace {

struct Op {
  enum Kind : uint8_t { Add, Cancel, Take } kind;
  NewOrder order;
  uint32_t target;  // for Cancel: index of an earlier Add
};

// A market that looks like the simulator's: most messages are passive orders
// near the touch and their cancellations, with a steady stream of takers.
std::vector<Op> make_stream(size_t n, uint64_t seed) {
  Rng rng(seed);
  std::vector<Op> ops;
  ops.reserve(n);
  std::vector<uint32_t> live;
  double mid = 10000;
  for (size_t i = 0; i < n; ++i) {
    mid += rng.normal() * 0.05;
    const double u = rng.uniform();
    Op op{};
    if (u < 0.45 && !live.empty()) {
      const uint32_t k = rng.below(static_cast<uint32_t>(live.size()));
      op.kind = Op::Cancel;
      op.target = live[k];
      live[k] = live.back();
      live.pop_back();
    } else if (u < 0.55) {
      op.kind = Op::Take;
      op.order = {static_cast<TraderId>(1 + rng.below(64)), rng.chance(0.5) ? Side::Buy : Side::Sell,
                  OrderType::Market, TimeInForce::IOC, false, kNoPrice,
                  static_cast<Qty>(10 + rng.below(200))};
    } else {
      const Side side = rng.chance(0.5) ? Side::Buy : Side::Sell;
      const Price away = static_cast<Price>(1 + rng.power_law(1.6, 60));
      op.kind = Op::Add;
      op.order = {static_cast<TraderId>(1 + rng.below(64)), side, OrderType::Limit, TimeInForce::GTC,
                  false, static_cast<Price>(mid) + (side == Side::Buy ? -away : away),
                  static_cast<Qty>(10 + rng.below(200))};
      live.push_back(static_cast<uint32_t>(i));
    }
    ops.push_back(op);
  }
  return ops;
}

}  // namespace

int main(int argc, char** argv) {
  const size_t n = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 5'000'000;
  const std::vector<Op> ops = make_stream(n, 2024);
  std::vector<OrderId> ids(n, 0);

  // Pass 1: throughput. One clock read at each end.
  double best = 0;
  uint64_t fills = 0;
  size_t counts[3] = {};
  for (int rep = 0; rep < 5; ++rep) {
    OrderBook book;
    fills = 0;
    counts[0] = counts[1] = counts[2] = 0;
    const auto t0 = Clock::now();
    for (size_t i = 0; i < n; ++i) {
      const Op& op = ops[i];
      counts[op.kind]++;
      if (op.kind == Op::Cancel) {
        book.cancel(ids[op.target]);
      } else {
        const Result r = book.submit(op.order);
        ids[i] = r.resting > 0 ? r.id : 0;
        fills += book.fills().size();
      }
    }
    const double sec = std::chrono::duration<double>(Clock::now() - t0).count();
    best = std::max(best, static_cast<double>(n) / sec);
  }

  // Pass 2: latency distribution. Timing every call adds clock overhead, so
  // these numbers are an upper bound.
  std::vector<uint32_t> lat;
  lat.reserve(n);
  {
    OrderBook book;
    for (size_t i = 0; i < n; ++i) {
      const Op& op = ops[i];
      const auto t0 = Clock::now();
      if (op.kind == Op::Cancel) {
        book.cancel(ids[op.target]);
      } else {
        const Result r = book.submit(op.order);
        ids[i] = r.resting > 0 ? r.id : 0;
      }
      lat.push_back(static_cast<uint32_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - t0).count()));
    }
  }
  std::sort(lat.begin(), lat.end());
  auto pct = [&](double p) { return lat[static_cast<size_t>(p * static_cast<double>(lat.size() - 1))]; };

  std::printf("operations   %zu  (%zu adds, %zu cancels, %zu takers, %llu fills)\n", n, counts[0],
              counts[1], counts[2], static_cast<unsigned long long>(fills));
  std::printf("throughput   %.1f million operations per second (best of 5)\n", best / 1e6);
  std::printf("mean         %.0f ns per operation\n", 1e9 / best);
  std::printf("latency      p50 %u ns   p99 %u ns   p99.9 %u ns   (includes ~20 ns of timer overhead)\n",
              pct(0.50), pct(0.99), pct(0.999));
  return 0;
}
