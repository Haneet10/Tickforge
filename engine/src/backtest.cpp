#include "tf/backtest.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <numeric>

namespace tf {

// ----------------------------------------------------------- scenarios ----

namespace {
constexpr const char* kScenarioKeys[] = {"none",     "crash",      "news-bad", "news-good",
                                         "whale",    "fat-finger", "drought",  "storm"};
}  // namespace

const char* scenario_key(ScenarioKind kind) {
  const auto i = static_cast<size_t>(kind);
  return i < static_cast<size_t>(ScenarioKind::Count) ? kScenarioKeys[i] : "none";
}

bool parse_scenario(const std::string& key, ScenarioKind& out) {
  for (size_t i = 0; i < static_cast<size_t>(ScenarioKind::Count); ++i) {
    if (key == kScenarioKeys[i]) {
      out = static_cast<ScenarioKind>(i);
      return true;
    }
  }
  return false;
}

void fire_scenario(Market& m, ScenarioKind kind) {
  // Same sizes as the terminal's scenario menu (web/src/app.ts).
  switch (kind) {
    case ScenarioKind::FlashCrash: m.flash_crash(1.0); break;
    case ScenarioKind::BadNews: m.news(-0.02); break;
    case ScenarioKind::GoodNews: m.news(0.02); break;
    case ScenarioKind::Whale: m.whale(Side::Buy, 25000, 90); break;
    case ScenarioKind::FatFinger: m.fat_finger(Side::Sell, 15000); break;
    case ScenarioKind::Drought: m.liquidity_drought(60); break;
    case ScenarioKind::Storm: m.volatility_burst(120, 3); break;
    case ScenarioKind::None:
    case ScenarioKind::Count: break;
  }
}

// ---------------------------------------------------------- strategies ----

namespace {

/// Shared execution logic: strategies decide a target position, this moves
/// the account toward it one clip at a time.
class TargetTrader : public Strategy {
 public:
  void stop(Market& m) override { cancel_working(m); }

 protected:
  /// Aggressive: an immediate-or-cancel order at the far touch, which pays the
  /// spread but trades now. Passive: one order joining the near touch, re-pegged
  /// each tick, which earns the spread if someone trades with it.
  void work_toward(Market& m, int64_t target, Qty clip, bool aggressive) {
    const int64_t pos = m.account(0).position;
    const int64_t gap = target - pos;
    const OrderBook& book = m.book();
    if (gap == 0 || m.halted()) {
      cancel_working(m);
      return;
    }
    const Side side = gap > 0 ? Side::Buy : Side::Sell;
    const Qty qty = static_cast<Qty>(std::min<int64_t>(std::abs(gap), clip));
    if (aggressive) {
      cancel_working(m);
      const Price far = side == Side::Buy ? book.best_ask() : book.best_bid();
      if (far != kNoPrice) m.user_limit(side, far, qty, TimeInForce::IOC, false);
      return;
    }
    const Price near = side == Side::Buy ? book.best_bid() : book.best_ask();
    if (near == kNoPrice) return;
    if (const OrderBook::Order* live = working_ ? book.find(working_) : nullptr) {
      // Keep queue position while the order is still the right side and price.
      if (live->side == side && live->price == near) return;
    }
    cancel_working(m);
    const Result r = m.user_limit(side, near, qty, TimeInForce::GTC, true);
    working_ = r.resting > 0 ? r.id : 0;
  }

  void cancel_working(Market& m) {
    if (working_) m.user_cancel(working_);
    working_ = 0;
  }

  static double ema_alpha(double dt, double tau) { return 1.0 - std::exp(-dt / tau); }

 private:
  OrderId working_ = 0;
};

class QuotingStrategy final : public Strategy {
 public:
  explicit QuotingStrategy(const double* p) {
    bp_.gamma = p[0];
    bp_.size = static_cast<Qty>(p[1]);
    bp_.max_inventory = static_cast<int64_t>(p[2]);
    bp_.horizon = p[3];
  }
  void start(Market& m) override { m.set_bot(true, bp_); }
  void tick(Market&) override {}  // the engine's bot does the quoting
  void stop(Market& m) override { m.set_bot(false, bp_); }
  Time interval() const override { return kSecond; }

 private:
  BotParams bp_;
};

/// Trend following: buy when a fast moving average of the mid pulls away above
/// a slow one by more than volatility alone explains, sell when below.
class MomentumStrategy final : public TargetTrader {
 public:
  explicit MomentumStrategy(const double* p)
      : fast_s_(p[0]), slow_s_(std::max(p[1], p[0] + 1)), entry_(p[2]), max_pos_(static_cast<int64_t>(p[3])), cross_(p[4] > 0.5) {}
  void tick(Market& m) override {
    const double mid = m.mid();
    const double t = m.seconds();
    if (last_ < 0) {
      fast_ = slow_ = mid;
      last_ = t;
      return;
    }
    const double dt = t - last_;
    last_ = t;
    fast_ += ema_alpha(dt, fast_s_) * (mid - fast_);
    slow_ += ema_alpha(dt, slow_s_) * (mid - slow_);
    const double scale = std::max(0.5, m.sigma_slow()) * std::sqrt(slow_s_);
    const double z = (fast_ - slow_) / scale;
    if (z > entry_) target_ = max_pos_;
    else if (z < -entry_) target_ = -max_pos_;
    else if (std::abs(z) < entry_ * 0.25) target_ = 0;
    work_toward(m, target_, 100, cross_);
  }
  Time interval() const override { return 250 * kMillisecond; }

 private:
  double fast_s_, slow_s_, entry_;
  int64_t max_pos_;
  bool cross_;
  double fast_ = 0, slow_ = 0, last_ = -1;
  int64_t target_ = 0;
};

/// Fade stretches: when the mid is several standard deviations from its
/// moving average, take the other side with passive orders and wait for it to
/// come back.
class MeanReversionStrategy final : public TargetTrader {
 public:
  explicit MeanReversionStrategy(const double* p)
      : window_(p[0]), entry_(p[1]), exit_(std::min(p[2], p[1] * 0.9)), max_pos_(static_cast<int64_t>(p[3])), cross_(p[4] > 0.5) {}
  void tick(Market& m) override {
    const double mid = m.mid();
    const double t = m.seconds();
    if (last_ < 0) {
      mean_ = mid;
      var_ = std::pow(std::max(1.0, m.sigma_slow()), 2) * window_ * 0.25;
      last_ = t;
      started_ = t;
      return;
    }
    const double a = ema_alpha(t - last_, window_);
    last_ = t;
    const double dev = mid - mean_;
    mean_ += a * dev;
    var_ = (1 - a) * (var_ + a * dev * dev);  // exponentially weighted variance
    if (t - started_ < window_ * 0.5) return;  // let the average settle
    const double z = (mid - mean_) / std::sqrt(std::max(var_, 1e-6));
    if (z > entry_) target_ = -max_pos_;
    else if (z < -entry_) target_ = max_pos_;
    else if ((target_ > 0 && z > -exit_) || (target_ < 0 && z < exit_)) target_ = 0;
    work_toward(m, target_, 100, cross_);
  }
  Time interval() const override { return 200 * kMillisecond; }

 private:
  double window_, entry_, exit_;
  int64_t max_pos_;
  bool cross_;
  double mean_ = 0, var_ = 0, last_ = -1, started_ = 0;
  int64_t target_ = 0;
};

/// Order-book imbalance: when much more size is bid than offered near the
/// touch, the next move is more likely up. Take it, hold briefly, get out.
class ImbalanceStrategy final : public TargetTrader {
 public:
  explicit ImbalanceStrategy(const double* p)
      : threshold_(p[0]), hold_(p[1]), levels_(static_cast<int>(p[2])), clip_(static_cast<Qty>(p[3])), cross_(p[4] > 0.5) {}
  void tick(Market& m) override {
    const double t = m.seconds();
    LevelView bids[8], asks[8];
    const int nb = m.book().depth(Side::Buy, bids, levels_);
    const int na = m.book().depth(Side::Sell, asks, levels_);
    double bq = 0, aq = 0;
    for (int i = 0; i < nb; ++i) bq += bids[i].qty;
    for (int i = 0; i < na; ++i) aq += asks[i].qty;
    const double imb = bq + aq > 0 ? (bq - aq) / (bq + aq) : 0;
    const int64_t pos = m.account(0).position;
    if (imb > threshold_ && pos <= 0) {
      target_ = clip_;
      entered_ = t;
    } else if (imb < -threshold_ && pos >= 0) {
      target_ = -clip_;
      entered_ = t;
    } else if (target_ != 0 && t - entered_ >= hold_) {
      target_ = 0;
    }
    work_toward(m, target_, clip_, cross_);
  }

 private:
  double threshold_, hold_;
  int levels_;
  Qty clip_;
  bool cross_;
  int64_t target_ = 0;
  double entered_ = 0;
};

constexpr const char* kCrossHelp =
    "On: take the far side of the book now and pay the spread and fees. Off: join the near side, wait, and "
    "earn the spread and a rebate if someone trades with you.";

const StrategyInfo kCatalog[] = {
    {StrategyId::Quoting, "quoting", "Avellaneda-Stoikov maker", "Earns the spread",
     "Quotes a bid and an offer around a reservation price that leans against inventory. Profits from "
     "uninformed flow, loses to informed flow and to trends.",
     4,
     {{{"gamma", "Risk aversion", "", 0.05, 0.005, 0.6, 0.005,
        "How hard quotes lean against inventory; higher is wider and safer."},
       {"size", "Quote size", "sh", 100, 10, 500, 10, "Shares on each side."},
       {"max_inventory", "Inventory limit", "sh", 1000, 100, 5000, 100,
        "Stops quoting the side that would go past this."},
       {"horizon", "Horizon", "s", 10, 2, 60, 1, "How far ahead price risk is priced in."}}}},
    {StrategyId::Momentum, "momentum", "Trend follower", "Rides moves",
     "Buys when a fast moving average pulls above a slow one by more than noise explains, sells when "
     "below. Crossing the spread to get in means it needs moves bigger than the cost.",
     5,
     {{{"fast", "Fast average", "s", 5, 1, 30, 1, "Time constant of the fast moving average."},
       {"slow", "Slow average", "s", 30, 5, 300, 5, "Time constant of the slow moving average."},
       {"entry", "Entry signal", "σ", 1.0, 0.2, 4, 0.1,
        "Gap between the averages, in units of volatility, needed to enter."},
       {"max_position", "Position", "sh", 500, 100, 3000, 100, "Size held while a trend is on."},
       {"cross", "Cross the spread", "", 1, 0, 1, 1, kCrossHelp}}}},
    {StrategyId::MeanReversion, "meanrev", "Mean reversion", "Fades stretches",
     "Sells when the price is stretched above its moving average and buys when below, with passive "
     "orders that earn the spread. Works in noisy markets and suffers in trends and crashes.",
     5,
     {{{"window", "Average window", "s", 60, 10, 600, 10, "Time constant of the moving average."},
       {"entry", "Entry z-score", "σ", 2.0, 0.5, 4, 0.1, "How stretched the price must be to fade it."},
       {"exit", "Exit z-score", "σ", 0.3, 0, 2, 0.1, "Close once the stretch has shrunk to this."},
       {"max_position", "Position", "sh", 500, 100, 3000, 100, "Size held while fading."},
       {"cross", "Cross the spread", "", 0, 0, 1, 1, kCrossHelp}}}},
    {StrategyId::Imbalance, "imbalance", "Book imbalance", "Reads the queue",
     "Goes long when far more size is bid than offered near the touch and short on the reverse, then "
     "gets out after a few seconds. The signal is small: whether it pays depends on how you execute it.",
     5,
     {{{"threshold", "Imbalance", "", 0.5, 0.1, 0.95, 0.05,
        "(bid size - ask size) / total needed to trade."},
       {"hold", "Holding time", "s", 3, 0.5, 30, 0.5, "How long a position is held before closing."},
       {"levels", "Book levels", "", 3, 1, 8, 1, "Price levels on each side counted in the signal."},
       {"clip", "Clip size", "sh", 100, 10, 1000, 10, "Shares per trade."},
       {"cross", "Cross the spread", "", 0, 0, 1, 1, kCrossHelp}}}},
};

}  // namespace

const StrategyInfo& strategy_info(StrategyId id) {
  const auto i = std::min<size_t>(static_cast<size_t>(id), static_cast<size_t>(StrategyId::Count) - 1);
  return kCatalog[i];
}

bool parse_strategy(const std::string& key, StrategyId& out) {
  for (const StrategyInfo& s : kCatalog) {
    if (key == s.key) {
      out = s.id;
      return true;
    }
  }
  return false;
}

std::unique_ptr<Strategy> make_strategy(StrategyId id, const double* params) {
  const StrategyInfo& info = strategy_info(id);
  double p[kMaxStrategyParams];
  for (int i = 0; i < kMaxStrategyParams; ++i) {
    const ParamInfo& pi = info.params[i];
    const double v = params && i < info.param_count && std::isfinite(params[i]) ? params[i] : pi.def;
    p[i] = i < info.param_count ? std::clamp(v, pi.min, pi.max) : 0.0;
  }
  switch (info.id) {
    case StrategyId::Quoting: return std::make_unique<QuotingStrategy>(p);
    case StrategyId::Momentum: return std::make_unique<MomentumStrategy>(p);
    case StrategyId::MeanReversion: return std::make_unique<MeanReversionStrategy>(p);
    case StrategyId::Imbalance: return std::make_unique<ImbalanceStrategy>(p);
    case StrategyId::Count: break;
  }
  return nullptr;
}

namespace {
void json_string(std::string& out, const char* s) {
  out += '"';
  for (; *s; ++s) {
    if (*s == '"' || *s == '\\') out += '\\';
    out += *s;
  }
  out += '"';
}
void json_number(std::string& out, double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.10g", v);
  out += buf;
}
}  // namespace

std::string strategy_catalog_json() {
  std::string o = "[";
  for (const StrategyInfo& s : kCatalog) {
    if (o.size() > 1) o += ',';
    o += "{\"id\":";
    json_number(o, static_cast<double>(s.id));
    o += ",\"key\":";
    json_string(o, s.key);
    o += ",\"name\":";
    json_string(o, s.name);
    o += ",\"style\":";
    json_string(o, s.style);
    o += ",\"blurb\":";
    json_string(o, s.blurb);
    o += ",\"params\":[";
    for (int i = 0; i < s.param_count; ++i) {
      const ParamInfo& p = s.params[i];
      if (i) o += ',';
      o += "{\"key\":";
      json_string(o, p.key);
      o += ",\"label\":";
      json_string(o, p.label);
      o += ",\"unit\":";
      json_string(o, p.unit);
      o += ",\"def\":";
      json_number(o, p.def);
      o += ",\"min\":";
      json_number(o, p.min);
      o += ",\"max\":";
      json_number(o, p.max);
      o += ",\"step\":";
      json_number(o, p.step);
      o += ",\"help\":";
      json_string(o, p.help);
      o += '}';
    }
    o += "]}";
  }
  return o + "]";
}

// ------------------------------------------------------------- metrics ----

double sharpe_ratio(const std::vector<double>& equity, double periods_per_year) {
  const size_t n = equity.size();
  if (n < 3) return 0;
  double sum = 0;
  for (size_t i = 1; i < n; ++i) sum += equity[i] - equity[i - 1];
  const double mean = sum / static_cast<double>(n - 1);
  double ss = 0;
  for (size_t i = 1; i < n; ++i) ss += std::pow(equity[i] - equity[i - 1] - mean, 2);
  const double sd = std::sqrt(ss / static_cast<double>(n - 2));
  if (sd < 1e-12) return 0;
  return mean / sd * std::sqrt(periods_per_year);
}

double max_drawdown(const std::vector<double>& equity) {
  double peak = equity.empty() ? 0 : equity.front();
  double dd = 0;
  for (double e : equity) {
    peak = std::max(peak, e);
    dd = std::max(dd, peak - e);
  }
  return dd;
}

double percentile(std::vector<double> xs, double q) {
  if (xs.empty()) return 0;
  std::sort(xs.begin(), xs.end());
  const double pos = std::clamp(q, 0.0, 1.0) * static_cast<double>(xs.size() - 1);
  const size_t lo = static_cast<size_t>(pos);
  const size_t hi = std::min(lo + 1, xs.size() - 1);
  return xs[lo] + (pos - static_cast<double>(lo)) * (xs[hi] - xs[lo]);
}

// -------------------------------------------------------------- runner ----

BacktestResult run_backtest(Strategy& strategy, const BacktestSpec& spec, const Config& base) {
  Config cfg = base;
  cfg.seed = spec.seed;
  Market m(cfg);
  m.step(static_cast<Time>(std::max(0.0, spec.warmup) * kSecond));
  m.user_reset();

  BacktestResult r;
  r.spec = spec;
  const int seconds = std::max(1, static_cast<int>(std::lround(spec.duration)));
  const int fire_at = spec.scenario == ScenarioKind::None
                          ? -1
                          : std::clamp(static_cast<int>(std::lround(spec.scenario_at * seconds)), 0, seconds - 1);
  r.equity.reserve(seconds + 1);
  r.position.reserve(seconds + 1);
  r.mid.reserve(seconds + 1);
  auto sample = [&] {
    r.equity.push_back(m.user_pnl().total / 100.0);
    r.position.push_back(static_cast<double>(m.account(0).position));
    r.mid.push_back(m.mid() / 100.0);
  };

  strategy.start(m);
  sample();
  const Time step = std::clamp<Time>(strategy.interval(), kMillisecond, kSecond);
  int64_t in_market = 0, max_pos = 0;
  Time next_tick = m.now();
  for (int s = 0; s < seconds; ++s) {
    if (s == fire_at) fire_scenario(m, spec.scenario);
    const Time end = m.now() + kSecond;
    while (m.now() < end) {
      if (m.now() >= next_tick) {
        strategy.tick(m);
        next_tick += step;
      }
      m.step(std::min(next_tick, end) - m.now());
      max_pos = std::max<int64_t>(max_pos, std::abs(m.account(0).position));
    }
    if (m.account(0).position != 0) ++in_market;
    sample();
  }
  strategy.stop(m);
  m.user_cancel_all();
  if (spec.flatten && m.account(0).position != 0) {
    m.user_flatten();
    r.equity.back() = m.user_pnl().total / 100.0;
    r.position.back() = static_cast<double>(m.account(0).position);
  }

  const PnlBreakdown& p = m.user_pnl();
  const Account& a = m.account(0);
  BacktestMetrics& k = r.metrics;
  k.pnl = p.total / 100.0;
  k.spread = p.spread / 100.0;
  k.inventory = p.inventory / 100.0;
  k.fees = p.fees / 100.0;
  k.sharpe = sharpe_ratio(r.equity);
  k.max_drawdown = max_drawdown(r.equity);
  k.volume = a.volume;
  k.trades = a.trades;
  k.maker_share = a.volume ? static_cast<double>(a.maker_volume) / static_cast<double>(a.volume) : 0;
  k.max_position = max_pos;
  k.time_in_market = static_cast<double>(in_market) / seconds;
  for (int i = 0; i < 3; ++i)
    k.markout[i] = p.markout_qty[i] ? p.markout_sum[i] / static_cast<double>(p.markout_qty[i]) : 0;
  k.market_move = r.mid.back() - r.mid.front();
  return r;
}

BacktestResult run_backtest(StrategyId id, const double* params, const BacktestSpec& spec,
                            const Config& base) {
  std::unique_ptr<Strategy> s = make_strategy(id, params);
  return run_backtest(*s, spec, base);
}

BatchSummary summarize(const std::vector<double>& pnls, const std::vector<double>& sharpes,
                       const std::vector<double>& drawdowns) {
  BatchSummary b;
  b.runs = static_cast<int>(pnls.size());
  if (pnls.empty()) return b;
  const double n = static_cast<double>(pnls.size());
  b.mean = std::accumulate(pnls.begin(), pnls.end(), 0.0) / n;
  if (pnls.size() > 1) {
    double ss = 0;
    for (double x : pnls) ss += (x - b.mean) * (x - b.mean);
    b.stdev = std::sqrt(ss / (n - 1));
  }
  b.t_stat = b.stdev > 0 ? b.mean / (b.stdev / std::sqrt(n)) : 0;
  b.median = percentile(pnls, 0.5);
  b.p05 = percentile(pnls, 0.05);
  b.p95 = percentile(pnls, 0.95);
  b.worst = *std::min_element(pnls.begin(), pnls.end());
  b.best = *std::max_element(pnls.begin(), pnls.end());
  b.win_rate = static_cast<double>(std::count_if(pnls.begin(), pnls.end(), [](double x) { return x > 0; })) / n;
  if (!sharpes.empty()) b.mean_sharpe = std::accumulate(sharpes.begin(), sharpes.end(), 0.0) / sharpes.size();
  if (!drawdowns.empty())
    b.mean_drawdown = std::accumulate(drawdowns.begin(), drawdowns.end(), 0.0) / drawdowns.size();
  return b;
}

BatchSummary summarize(const std::vector<BacktestResult>& runs) {
  std::vector<double> pnl, sh, dd;
  for (const BacktestResult& r : runs) {
    pnl.push_back(r.metrics.pnl);
    sh.push_back(r.metrics.sharpe);
    dd.push_back(r.metrics.max_drawdown);
  }
  return summarize(pnl, sh, dd);
}

}  // namespace tf
