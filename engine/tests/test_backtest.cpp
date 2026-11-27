#include <cmath>
#include <cstdlib>
#include <string>

#include "check.hpp"
#include "tf/backtest.hpp"

using namespace tf;

namespace {

BacktestSpec short_spec(uint64_t seed, double seconds = 120) {
  BacktestSpec s;
  s.seed = seed;
  s.warmup = 120;
  s.duration = seconds;
  return s;
}

/// A strategy that does exactly one thing: buys 300 shares at the first tick.
class BuyOnce final : public Strategy {
 public:
  void tick(Market& m) override {
    if (!done_) m.user_market(Side::Buy, 300);
    done_ = true;
  }
  bool done_ = false;
};

}  // namespace

// ------------------------------------------------------------- metrics ----

TEST("backtest: Sharpe ratio by hand") {
  // Changes 1, 2, -1, 2: mean 1, sample variance (0 + 1 + 4 + 1) / 3 = 2.
  const std::vector<double> eq = {0, 1, 3, 2, 4};
  CHECK_NEAR(sharpe_ratio(eq, 1.0), 1.0 / std::sqrt(2.0), 1e-12);
  CHECK_NEAR(sharpe_ratio(eq, 100.0), 10.0 / std::sqrt(2.0), 1e-12);
  CHECK_EQ(sharpe_ratio({0, 1, 2, 3}, 1.0), 0.0);  // no variance
  CHECK_EQ(sharpe_ratio({0, 1}, 1.0), 0.0);        // too short
  CHECK(sharpe_ratio({0, -1, -3, -2, -4}, 1.0) < 0);
}

TEST("backtest: max drawdown by hand") {
  CHECK_EQ(max_drawdown({0, 5, 2, 6, 1, 3}), 5.0);
  CHECK_EQ(max_drawdown({0, 1, 2, 3}), 0.0);
  CHECK_EQ(max_drawdown({0, -4, 2}), 4.0);
  CHECK_EQ(max_drawdown({}), 0.0);
}

TEST("backtest: percentiles and batch summary") {
  const std::vector<double> xs = {5, 1, 4, 2, 3};
  CHECK_EQ(percentile(xs, 0.0), 1.0);
  CHECK_EQ(percentile(xs, 0.5), 3.0);
  CHECK_EQ(percentile(xs, 1.0), 5.0);
  CHECK_NEAR(percentile(xs, 0.1), 1.4, 1e-12);  // interpolated between 1 and 2

  const BatchSummary b = summarize({-2, 0, 2, 4, 6}, {1, 2, 3, 4, 5}, {2, 2, 2, 2, 2});
  CHECK_EQ(b.runs, 5);
  CHECK_NEAR(b.mean, 2.0, 1e-12);
  CHECK_NEAR(b.stdev, std::sqrt(10.0), 1e-12);  // squares 16+4+0+4+16 = 40, over 4
  CHECK_NEAR(b.t_stat, 2.0 / (std::sqrt(10.0) / std::sqrt(5.0)), 1e-12);
  CHECK_NEAR(b.win_rate, 0.6, 1e-12);  // zero is not a win
  CHECK_EQ(b.median, 2.0);
  CHECK_EQ(b.worst, -2.0);
  CHECK_EQ(b.best, 6.0);
  CHECK_NEAR(b.mean_sharpe, 3.0, 1e-12);
  CHECK_NEAR(b.mean_drawdown, 2.0, 1e-12);
}

// ----------------------------------------------------------- catalogue ----

TEST("backtest: catalogue, parsing and parameter clamping") {
  for (int i = 0; i < static_cast<int>(StrategyId::Count); ++i) {
    const StrategyInfo& s = strategy_info(static_cast<StrategyId>(i));
    StrategyId parsed;
    CHECK(parse_strategy(s.key, parsed));
    CHECK(parsed == s.id);
    CHECK(s.param_count >= 1 && s.param_count <= kMaxStrategyParams);
    for (int k = 0; k < s.param_count; ++k) {
      const ParamInfo& p = s.params[k];
      CHECK(p.min <= p.def && p.def <= p.max && p.step > 0);
    }
  }
  StrategyId id;
  CHECK(!parse_strategy("martingale", id));
  ScenarioKind sk;
  CHECK(parse_scenario("crash", sk) && sk == ScenarioKind::FlashCrash);
  CHECK(!parse_scenario("meteor", sk));
  for (int i = 0; i < static_cast<int>(ScenarioKind::Count); ++i) {
    CHECK(parse_scenario(scenario_key(static_cast<ScenarioKind>(i)), sk));
    CHECK(static_cast<int>(sk) == i);
  }

  const std::string json = strategy_catalog_json();
  CHECK(json.front() == '[' && json.back() == ']');
  CHECK(json.find("\"key\":\"meanrev\"") != std::string::npos);
  CHECK(json.find("\"key\":\"cross\"") != std::string::npos);

  // Out-of-range parameters are clamped, not trusted: a huge position limit
  // still trades at most the catalogue maximum.
  const double wild[] = {1, 5, 0.2, 1e9, 1};
  const BacktestResult r = run_backtest(StrategyId::Momentum, wild, short_spec(5, 200));
  CHECK(r.metrics.max_position <= 3000);
}

// -------------------------------------------------------------- runner ----

TEST("backtest: same seed and parameters, same result") {
  for (int i = 0; i < static_cast<int>(StrategyId::Count); ++i) {
    const auto id = static_cast<StrategyId>(i);
    const BacktestResult a = run_backtest(id, nullptr, short_spec(11));
    const BacktestResult b = run_backtest(id, nullptr, short_spec(11));
    CHECK_EQ(a.equity, b.equity);
    CHECK_EQ(a.metrics.volume, b.metrics.volume);
    const BacktestResult c = run_backtest(id, nullptr, short_spec(12));
    CHECK(a.mid != c.mid);
  }
}

TEST("backtest: sampling, flattening and the P&L identity") {
  for (int i = 0; i < static_cast<int>(StrategyId::Count); ++i) {
    const BacktestResult r = run_backtest(static_cast<StrategyId>(i), nullptr, short_spec(21, 180));
    const BacktestMetrics& k = r.metrics;
    CHECK_EQ(r.equity.size(), size_t{181});
    CHECK_EQ(r.position.size(), size_t{181});
    CHECK_EQ(r.mid.size(), size_t{181});
    CHECK_EQ(r.equity.front(), 0.0);
    CHECK_EQ(r.position.front(), 0.0);
    CHECK_EQ(r.position.back(), 0.0);  // flattened
    CHECK_NEAR(k.pnl, r.equity.back(), 1e-9);
    CHECK_NEAR(k.spread + k.inventory - k.fees, k.pnl, 1e-6);
    CHECK(k.volume > 0);
    CHECK(k.max_drawdown >= 0);
    CHECK(k.time_in_market >= 0 && k.time_in_market <= 1);
    CHECK_NEAR(k.market_move, r.mid.back() - r.mid.front(), 1e-12);
  }
}

TEST("backtest: a hand-built strategy and an unflattened run") {
  BuyOnce s;
  BacktestSpec spec = short_spec(31, 60);
  spec.flatten = false;
  const BacktestResult r = run_backtest(s, spec);
  CHECK_EQ(r.position.back(), 300.0);
  CHECK_EQ(r.metrics.max_position, int64_t{300});
  CHECK_EQ(r.metrics.maker_share, 0.0);  // a market order only takes
  CHECK(r.metrics.fees > 0);             // and pays the taker fee
  CHECK_NEAR(r.metrics.time_in_market, 1.0, 1e-12);
  // Holding 300 shares, the P&L tracks the mid: equity minus 300 x (mid change)
  // is just the cost of getting in, so it stays put second to second.
  const double entry_cost0 = r.equity[1] - 300 * (r.mid[1] - r.mid[0]);
  const double entry_cost1 = r.equity.back() - 300 * (r.mid.back() - r.mid[0]);
  CHECK_NEAR(entry_cost0, entry_cost1, 1e-6);
}

TEST("backtest: execution style shows up in the fills") {
  // Momentum crosses the spread by default; mean reversion and imbalance rest.
  const double eager[] = {5, 30, 0.5, 500, 1};  // low entry bar, so it trades in a calm market
  const BacktestResult mom = run_backtest(StrategyId::Momentum, eager, short_spec(41, 300));
  const BacktestResult rev = run_backtest(StrategyId::MeanReversion, nullptr, short_spec(41, 300));
  const BacktestResult imb = run_backtest(StrategyId::Imbalance, nullptr, short_spec(41, 300));
  CHECK(mom.metrics.volume > 0);
  CHECK(mom.metrics.maker_share < 0.05);
  CHECK(mom.metrics.fees > 0);
  CHECK(rev.metrics.maker_share > 0.8);
  CHECK(imb.metrics.maker_share > 0.8);
  CHECK(imb.metrics.fees < 0);  // rebates outweigh the closing trade's fee
  // Flip imbalance to aggressive: same signal, now it pays to trade.
  const double aggressive[] = {0.5, 3, 3, 100, 1};
  const BacktestResult imb_x = run_backtest(StrategyId::Imbalance, aggressive, short_spec(41, 300));
  CHECK(imb_x.metrics.maker_share < 0.05);
  CHECK(imb_x.metrics.fees > 0);
  CHECK(imb_x.metrics.pnl < imb.metrics.pnl);
}

TEST("backtest: positions stay inside their limits") {
  const double quoting[] = {0.05, 100, 400, 10};
  const BacktestResult q = run_backtest(StrategyId::Quoting, quoting, short_spec(51, 300));
  CHECK(q.metrics.max_position <= 400 + 100);  // one clip can fill past the limit
  const double imb[] = {0.3, 3, 3, 150, 0};
  const BacktestResult i = run_backtest(StrategyId::Imbalance, imb, short_spec(51, 300));
  CHECK(i.metrics.max_position <= 150);
  const double rev[] = {60, 1.5, 0.3, 700, 0};
  const BacktestResult r = run_backtest(StrategyId::MeanReversion, rev, short_spec(51, 300));
  CHECK(r.metrics.max_position <= 700);
}

TEST("backtest: scenarios fire and move the market") {
  BacktestSpec calm = short_spec(61, 240);
  BacktestSpec crash = calm;
  crash.scenario = ScenarioKind::FlashCrash;
  crash.scenario_at = 0.25;
  const BacktestResult a = run_backtest(StrategyId::Imbalance, nullptr, calm);
  const BacktestResult b = run_backtest(StrategyId::Imbalance, nullptr, crash);
  // Identical until the scenario fires at second 60, then the crash bites.
  for (int s = 0; s <= 60; ++s) CHECK_EQ(a.mid[s], b.mid[s]);
  double low = 1e9;
  for (double m : b.mid) low = std::min(low, m);
  CHECK(low < b.mid[60] * 0.98);

  // News moves the price the right way.
  BacktestSpec good = calm;
  good.scenario = ScenarioKind::GoodNews;
  const BacktestResult g = run_backtest(StrategyId::Imbalance, nullptr, good);
  CHECK(g.mid.back() > g.mid[120] + 0.5);
}

TEST("backtest: the trend follower profits from a crash, the fader is run over") {
  // Averaged over a handful of seeds, the story the Lab tells has to hold.
  double mom = 0, rev = 0;
  for (uint64_t seed = 70; seed < 76; ++seed) {
    BacktestSpec s = short_spec(seed, 300);
    s.scenario = ScenarioKind::FlashCrash;
    s.scenario_at = 0.2;
    mom += run_backtest(StrategyId::Momentum, nullptr, s).metrics.pnl;
    rev += run_backtest(StrategyId::MeanReversion, nullptr, s).metrics.pnl;
  }
  CHECK(mom > 0);
  CHECK(rev < 0);
}
