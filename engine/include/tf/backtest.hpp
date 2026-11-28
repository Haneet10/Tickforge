// Strategy backtesting against the simulated market.
//
// A Strategy trades the user's account. The runner warms a market up, hands
// the strategy control for a fixed session, samples its equity once a second
// and reduces the run to a handful of numbers a trading desk would ask for.
//
// Because the market is deterministic from its seed, a backtest is exactly
// repeatable, and two strategies run on the same seeds face the same order
// flow up to the point where their own orders change it. That makes paired
// comparisons meaningful with a few dozen seeds.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "tf/market.hpp"

namespace tf {

// ----------------------------------------------------------- scenarios ----

/// The scenario menu from the terminal, with the same parameters.
enum class ScenarioKind : uint8_t {
  None = 0,
  FlashCrash = 1,
  BadNews = 2,
  GoodNews = 3,
  Whale = 4,
  FatFinger = 5,
  Drought = 6,
  Storm = 7,
  Count = 8,
};

const char* scenario_key(ScenarioKind kind);
/// Parses a scenario key ("crash", "news-bad", ...). Returns false if unknown.
bool parse_scenario(const std::string& key, ScenarioKind& out);
void fire_scenario(Market& m, ScenarioKind kind);

// ---------------------------------------------------------- strategies ----

/// A trading strategy driving the user's account (trader 0).
///
/// The runner pauses the market every `interval()` and calls tick(). Between
/// ticks the strategy's resting orders sit in the book like anyone else's, so
/// the decision interval doubles as the strategy's reaction time.
class Strategy {
 public:
  virtual ~Strategy() = default;
  virtual void start(Market&) {}
  virtual void tick(Market& m) = 0;
  /// Called once at the end of the session, before any flattening.
  virtual void stop(Market&) {}
  virtual Time interval() const { return 100 * kMillisecond; }
};

enum class StrategyId : uint8_t {
  Quoting = 0,        // Avellaneda-Stoikov market making
  Momentum = 1,       // moving-average crossover, aggressive execution
  MeanReversion = 2,  // fades stretched prices with passive orders
  Imbalance = 3,      // top-of-book order imbalance, short holding period
  Count = 4,
};

inline constexpr int kMaxStrategyParams = 5;

struct ParamInfo {
  const char* key;
  const char* label;
  const char* unit;
  double def, min, max, step;
  const char* help;
};

struct StrategyInfo {
  StrategyId id;
  const char* key;
  const char* name;
  const char* style;  // one line: what kind of edge it is after
  const char* blurb;
  int param_count;
  std::array<ParamInfo, kMaxStrategyParams> params;
};

const StrategyInfo& strategy_info(StrategyId id);
bool parse_strategy(const std::string& key, StrategyId& out);

/// Builds a strategy. `params` holds param_count values in catalogue order;
/// pass nullptr for the defaults. Values are clamped to their ranges.
std::unique_ptr<Strategy> make_strategy(StrategyId id, const double* params = nullptr);

/// The whole catalogue as JSON, for the browser.
std::string strategy_catalog_json();

// ------------------------------------------------------------- metrics ----

/// Trading days per year times seconds per 6.5-hour session: the factor that
/// annualises a Sharpe ratio measured on one-second P&L changes.
inline constexpr double kSecondsPerYear = 252.0 * 23400.0;

/// Annualised Sharpe ratio of a P&L path sampled at a fixed period. Uses the
/// changes between samples and the sample standard deviation. Zero when the
/// path is flat or too short.
double sharpe_ratio(const std::vector<double>& equity, double periods_per_year = kSecondsPerYear);

/// Largest peak-to-trough fall along the path (a positive number).
double max_drawdown(const std::vector<double>& equity);

/// Linear-interpolated percentile of an unsorted sample, q in [0, 1].
double percentile(std::vector<double> xs, double q);

// -------------------------------------------------------------- runner ----

struct BacktestSpec {
  uint64_t seed = 1;
  double warmup = 300;    // seconds of market before the strategy starts
  double duration = 600;  // seconds the strategy trades
  ScenarioKind scenario = ScenarioKind::None;
  double scenario_at = 0.5;  // when the scenario fires, as a fraction of the session
  bool flatten = true;       // close the position with a market order at the end
};

struct BacktestMetrics {
  // Dollars. pnl == spread + inventory - fees.
  double pnl = 0;
  double spread = 0;
  double inventory = 0;
  double fees = 0;
  double sharpe = 0;
  double max_drawdown = 0;
  // Activity.
  int64_t volume = 0;
  int32_t trades = 0;
  double maker_share = 0;    // fraction of volume that was passive
  int64_t max_position = 0;  // largest absolute position held
  double time_in_market = 0; // fraction of seconds with a non-zero position
  // Ticks per share, positive when the price moved in the strategy's favour.
  std::array<double, 3> markout{};  // 1, 5 and 30 seconds after each fill
  // The market the strategy faced.
  double market_move = 0;  // dollars per share, last mid minus first mid
};

struct BacktestResult {
  BacktestSpec spec;
  std::vector<double> equity;    // dollars, one sample per second, starting at 0
  std::vector<double> position;  // shares, same sampling
  std::vector<double> mid;       // dollars, same sampling
  BacktestMetrics metrics;
};

/// One strategy session that can be advanced a slice at a time.
///
/// run_backtest() is a BacktestSession driven to the end in one call. The
/// terminal drives the very same object a frame at a time to let you watch a
/// lab session trade, so what you see is bit-for-bit the run the lab scored:
/// the result depends only on the seed, the warm-up and the spec, never on how
/// the caller slices time.
///
/// The market must already be warmed up and its user account reset.
class BacktestSession {
 public:
  BacktestSession(Market& m, Strategy& strategy, const BacktestSpec& spec);

  /// Runs the session up to simulated time `t` (absolute, microseconds), or
  /// to its end, whichever comes first. Returns true once the session is over.
  bool advance_to(Time t);
  bool done() const { return done_; }
  /// Seconds completed so far, out of seconds().
  int second() const { return second_; }
  int seconds() const { return seconds_; }
  /// The session second at which the scenario fires, or -1 for none.
  int fire_at() const { return fire_at_; }
  Time start_time() const { return start_; }
  Time end_time() const { return start_ + static_cast<Time>(seconds_) * kSecond; }

  /// Stops the strategy, cancels its orders, flattens if the spec says so and
  /// computes the metrics. Call once, after done().
  BacktestResult finish();

 private:
  void sample();

  Market& m_;
  Strategy& strategy_;
  BacktestResult r_;
  int seconds_ = 0;
  int fire_at_ = -1;
  int second_ = 0;
  bool scenario_due_ = true;  // the start of a second has not been handled yet
  bool done_ = false;
  bool finished_ = false;
  Time start_ = 0;
  Time step_ = 0;
  Time next_tick_ = 0;
  Time second_end_ = 0;
  int64_t in_market_ = 0;
  int64_t max_pos_ = 0;
};

BacktestResult run_backtest(Strategy& strategy, const BacktestSpec& spec, const Config& base = {});
BacktestResult run_backtest(StrategyId id, const double* params, const BacktestSpec& spec,
                            const Config& base = {});

/// What a batch of runs (usually one per seed) says about a strategy.
struct BatchSummary {
  int runs = 0;
  double mean = 0, stdev = 0, median = 0, p05 = 0, p95 = 0;
  double win_rate = 0;  // fraction of runs that made money
  double mean_sharpe = 0;
  double mean_drawdown = 0;
  double worst = 0, best = 0;
  /// Mean P&L divided by its standard error: how many standard errors the
  /// edge is from zero. Above about 2, the result is unlikely to be luck.
  double t_stat = 0;
};

BatchSummary summarize(const std::vector<double>& pnls, const std::vector<double>& sharpes = {},
                       const std::vector<double>& drawdowns = {});
BatchSummary summarize(const std::vector<BacktestResult>& runs);

}  // namespace tf
