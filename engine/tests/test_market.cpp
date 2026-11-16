#include <algorithm>
#include <cmath>

#include "check.hpp"
#include "tf/market.hpp"

using namespace tf;

namespace {

void run(Market& m, double seconds) {
  // Step in roughly 60 fps slices, landing exactly on the target time.
  const Time end = m.now() + static_cast<Time>(seconds * kSecond);
  while (m.now() < end) m.step(std::min<Time>(16'667, end - m.now()));
}

uint64_t fingerprint(Market& m) {
  uint64_t h = 1469598103934665603ULL;
  auto mix = [&](uint64_t x) { h = (h ^ x) * 1099511628211ULL; };
  mix(static_cast<uint64_t>(m.last()));
  mix(static_cast<uint64_t>(m.total_volume()));
  mix(m.messages());
  mix(m.book().live_orders());
  mix(static_cast<uint64_t>(m.book().best_bid()));
  mix(static_cast<uint64_t>(m.book().best_ask()));
  for (TraderId t = 0; t < m.trader_count(); ++t) mix(static_cast<uint64_t>(m.account(t).position));
  return h;
}

}  // namespace

TEST("market: same seed, same market") {
  Config cfg;
  cfg.seed = 42;
  Market a(cfg), b(cfg);
  run(a, 120);
  run(b, 120);
  CHECK_EQ(fingerprint(a), fingerprint(b));
  cfg.seed = 43;
  Market c(cfg);
  run(c, 120);
  CHECK(fingerprint(a) != fingerprint(c));
}

TEST("market: the result does not depend on how time is sliced") {
  Config cfg;
  cfg.seed = 9;
  Market a(cfg), b(cfg);
  a.step(90 * kSecond);                                // one big step
  for (int i = 0; i < 90 * 1000; ++i) b.step(kMillisecond);  // 90,000 tiny ones
  CHECK_EQ(fingerprint(a), fingerprint(b));
}

TEST("market: shares and cash are conserved") {
  Config cfg;
  cfg.seed = 5;
  Market m(cfg);
  m.set_bot(true, {});
  run(m, 200);
  m.flash_crash(1.0);
  run(m, 200);
  int64_t net_position = 0, volume = 0;
  double net_cash = 0, net_fees = 0;
  for (TraderId t = 0; t < m.trader_count(); ++t) {
    const Account& a = m.account(t);
    net_position += a.position;
    net_cash += a.cash;
    net_fees += a.fees;
    volume += a.volume;
  }
  CHECK_EQ(net_position, 0);            // every share bought was sold by someone
  CHECK_NEAR(net_cash, 0.0, 1e-3);
  CHECK_EQ(volume, 2 * m.total_volume());  // each trade has two sides
  // What the exchange keeps: taker fee minus maker rebate on every share.
  CHECK_NEAR(net_fees, (cfg.taker_fee - cfg.maker_rebate) * static_cast<double>(m.total_volume()), 1e-3);
  CHECK(m.book().check_invariants());
}

TEST("market: a healthy market in normal conditions") {
  for (uint64_t seed : {1, 2, 3}) {
    Config cfg;
    cfg.seed = seed;
    Market m(cfg);
    run(m, 30);  // warm up
    double spread = 0, gap = 0;
    int n = 0, one_sided = 0;
    for (int i = 0; i < 6000; ++i) {
      m.step(100 * kMillisecond);
      if (m.book().has_bid() && m.book().has_ask()) {
        spread += m.book().best_ask() - m.book().best_bid();
        ++n;
      } else {
        ++one_sided;
      }
      gap += std::abs(m.mid() - m.fundamental());
    }
    CHECK(one_sided < 60);        // two-sided at least 99% of the time
    CHECK(spread / n < 4.0);      // tight spread
    CHECK(gap / 6000 < 40.0);     // price tracks fundamental value
    CHECK(m.total_trades() > 3000);
    // Dealers get paid for providing liquidity; uninformed flow pays for it.
    CHECK(m.kind_stats(Kind::Retail).pnl < 0);
  }
}

TEST("market: user P&L decomposition is exact") {
  Config cfg;
  cfg.seed = 17;
  Market m(cfg);
  run(m, 20);
  BotParams bp;
  bp.gamma = 0.02;
  m.set_bot(true, bp);
  for (int i = 0; i < 300; ++i) {
    run(m, 1);
    if (i % 37 == 0) m.user_market(i % 2 ? Side::Buy : Side::Sell, 150);
    if (i == 150) m.news(0.015);
    const PnlBreakdown pb = m.user_pnl();
    CHECK_NEAR(pb.total, pb.spread + pb.inventory - pb.fees, 1e-6 * (1 + std::abs(pb.total)));
    CHECK_NEAR(pb.total, m.account(0).equity(m.mid()), 1e-9);
  }
  CHECK(m.account(0).volume > 0);
  CHECK(m.user_pnl().markout_qty[2] > 0);
}

TEST("market: user orders are tracked through fills and cancels") {
  Config cfg;
  cfg.seed = 3;
  Market m(cfg);
  run(m, 10);
  const Price bid = m.book().best_bid();
  const Result deep = m.user_limit(Side::Buy, bid - 20, 100, TimeInForce::GTC, false);
  const Result touch = m.user_limit(Side::Buy, bid, 50, TimeInForce::GTC, false);
  CHECK(deep.ok());
  CHECK(touch.ok());
  UserOrder orders[8];
  CHECK_EQ(m.user_orders(orders, 8), 2);
  CHECK_EQ(m.user_qty_at(bid - 20), 100);
  CHECK(orders[1].queue_ahead > 0);  // joined the back of the queue at the best bid
  CHECK(m.user_cancel(deep.id));
  CHECK(!m.user_cancel(deep.id));
  CHECK_EQ(m.user_orders(orders, 8), 1);
  // A big sell sweeps through the user's bid.
  m.fat_finger(Side::Sell, 5000);
  run(m, 2);
  CHECK_EQ(m.user_orders(orders, 8), 0);
  CHECK_EQ(m.account(0).position, 50);
  CHECK_EQ(m.user_fill_count(), 1);
  CHECK_EQ(m.user_fill_at(0).is_maker, 1.0);
  CHECK_EQ(m.user_flatten().filled, 50);
  CHECK_EQ(m.account(0).position, 0);
}

TEST("market: order-entry collars") {
  Config cfg;
  cfg.seed = 3;
  Market m(cfg);
  run(m, 10);
  const Price last = m.last();
  // A limit order priced more than 10% away is refused.
  CHECK_EQ(m.user_limit(Side::Buy, last / 2, 10, TimeInForce::GTC, false).reject, Reject::BadPrice);
  // A market order cannot trade more than 2% through the book.
  const Result r = m.user_market(Side::Buy, 2'000'000);
  CHECK(r.filled > 0);
  CHECK(m.last() <= static_cast<Price>(std::ceil(last * 1.02)));
}

TEST("market: execution algorithms finish their parent order") {
  Config cfg;
  cfg.seed = 8;
  Market m(cfg);
  run(m, 20);
  const double before = m.mid();
  m.user_algo(Side::Buy, 3000, AlgoStyle::Twap, 30);
  run(m, 15);
  const AlgoStatus mid_way = m.user_algo_status();
  CHECK(mid_way.active);
  CHECK(mid_way.done > 1000 && mid_way.done < 2000);
  run(m, 20);
  const AlgoStatus done = m.user_algo_status();
  CHECK(!done.active);
  CHECK_EQ(done.done, 3000);
  CHECK_EQ(m.account(0).position, 3000);
  CHECK(done.shortfall_ticks > 0);  // buying 3,000 shares costs more than the arrival mid
  CHECK(done.avg_price > before);
}

TEST("market: news moves the price to the new value") {
  Config cfg;
  cfg.seed = 21;
  Market m(cfg);
  run(m, 60);
  const double before = m.mid();
  m.news(0.03);
  run(m, 180);
  CHECK(m.mid() > before + 0.02 * before);
  CHECK(std::abs(m.mid() - m.fundamental()) < 60);
}

TEST("market: a flash crash falls hard and then recovers") {
  Config cfg;
  cfg.seed = 3;
  Market m(cfg);
  run(m, 120);
  const double before = m.mid();
  m.flash_crash(1.0);
  double low = before;
  for (int i = 0; i < 400; ++i) {
    run(m, 1);
    low = std::min(low, m.mid());
  }
  CHECK(low < before * 0.97);            // at least a 3% drop
  CHECK(m.mid() > low + 0.6 * (before - low));  // most of it recovered
  CHECK(m.book().check_invariants());
}

TEST("market: the circuit breaker halts trading and then resumes") {
  Config cfg;
  cfg.seed = 1;
  cfg.breaker_enabled = true;
  Market m(cfg);
  run(m, 120);
  m.flash_crash(1.0);
  bool saw_halt = false;
  for (int i = 0; i < 2400 && !saw_halt; ++i) {
    m.step(100 * kMillisecond);
    saw_halt = m.halted();
  }
  CHECK(saw_halt);
  const int64_t volume = m.total_volume();
  CHECK_EQ(m.user_market(Side::Buy, 10).reject, Reject::Halted);
  run(m, 5);
  CHECK_EQ(m.total_volume(), volume);  // nothing trades during a halt
  run(m, 30);
  CHECK(m.total_volume() > volume);    // and it does again afterwards
}

TEST("market: one bar per second, each opening at the previous close") {
  Config cfg;
  cfg.seed = 4;
  Market m(cfg);
  run(m, 100);
  CHECK_EQ(m.bar_count(), 100);
  const Bar* bars = m.bars(0);
  int64_t volume = 0;
  for (int i = 0; i < 100; ++i) {
    CHECK(bars[i].low <= bars[i].open && bars[i].open <= bars[i].high);
    CHECK(bars[i].low <= bars[i].close && bars[i].close <= bars[i].high);
    if (i > 0) CHECK_EQ(bars[i].open, bars[i - 1].close);
    volume += bars[i].volume;
  }
  CHECK(volume <= m.total_volume());
  CHECK(m.total_volume() - volume < 2000);  // the rest is in the bar still forming
}

TEST("market: resetting the user leaves the market untouched") {
  Config cfg;
  cfg.seed = 6;
  Market m(cfg);
  run(m, 30);
  m.user_market(Side::Buy, 500);
  m.user_limit(Side::Sell, m.book().best_ask() + 5, 100, TimeInForce::GTC, false);
  run(m, 5);
  m.user_reset();
  CHECK_EQ(m.account(0).position, 0);
  CHECK_NEAR(m.user_pnl().total, 0.0, 1e-9);
  UserOrder orders[4];
  CHECK_EQ(m.user_orders(orders, 4), 0);
  CHECK(m.book().check_invariants());
}
