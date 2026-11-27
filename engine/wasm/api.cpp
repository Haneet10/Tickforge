// The C interface the browser talks to.
//
// One Market lives in each WebAssembly instance. Calls are plain numbers in
// and out. Anything bigger (depth, bars, the tape) is written into buffers in
// linear memory and the caller reads them through typed-array views, so
// nothing is serialised and nothing is copied twice.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>

#include <string>
#include <vector>

#include "tf/backtest.hpp"
#include "tf/market.hpp"

using namespace tf;

#define TF_EXPORT(name) __attribute__((export_name(#name))) name

namespace {

std::unique_ptr<Market> g_market;

constexpr int kMaxDepth = 256;
constexpr int kMaxUserOrders = 128;

double g_state[80];
double g_result[6];
int32_t g_depth[kMaxDepth * 4];
double g_tape[Market::kTapeSize * 6];
double g_fills[Market::kFillRing * 8];
double g_events[Market::kEventRing * 4];
double g_orders[kMaxUserOrders * 6];
double g_kinds[static_cast<int>(Kind::Count) * 5];

Side side_of(int s) { return s == 0 ? Side::Buy : Side::Sell; }

double* write_result(const Result& r) {
  g_result[0] = static_cast<double>(r.id);
  g_result[1] = static_cast<double>(r.status);
  g_result[2] = static_cast<double>(r.reject);
  g_result[3] = r.filled;
  g_result[4] = r.resting;
  g_result[5] = static_cast<double>(r.notional);
  return g_result;
}

}  // namespace

extern "C" {

void TF_EXPORT(tf_create)(double seed) {
  Config cfg;
  cfg.seed = static_cast<uint64_t>(seed);
  g_market = std::make_unique<Market>(cfg);
}

void TF_EXPORT(tf_step)(double seconds) {
  g_market->step(static_cast<Time>(seconds * 1e6));
}

// ------------------------------------------------------------- queries ----

double* TF_EXPORT(tf_state)() {
  Market& m = *g_market;
  const OrderBook& b = m.book();
  const PnlBreakdown& pb = m.user_pnl();
  const Account& acct = m.account(0);
  const BotStatus bot = m.bot_status();
  const AlgoStatus algo = m.user_algo_status();
  double* s = g_state;
  int i = 0;
  s[i++] = m.seconds();                                   // 0
  s[i++] = m.last();
  s[i++] = b.best_bid();
  s[i++] = b.best_ask();
  s[i++] = b.has_bid() ? b.qty_at(b.best_bid()) : 0;
  s[i++] = b.has_ask() ? b.qty_at(b.best_ask()) : 0;      // 5
  s[i++] = m.mid();
  s[i++] = m.microprice();
  s[i++] = m.fundamental();
  s[i++] = m.sigma();
  s[i++] = static_cast<double>(m.total_volume());         // 10
  s[i++] = static_cast<double>(m.total_trades());
  s[i++] = static_cast<double>(m.messages());
  s[i++] = m.vwap();
  s[i++] = m.session_high();
  s[i++] = m.session_low();                               // 15
  s[i++] = m.session_open();
  s[i++] = m.halt_remaining();
  s[i++] = m.liquidity_factor();
  s[i++] = b.live_orders();
  s[i++] = static_cast<double>(acct.position);            // 20
  s[i++] = acct.cash;
  s[i++] = pb.total;
  s[i++] = pb.spread;
  s[i++] = pb.inventory;
  s[i++] = pb.fees;                                       // 25
  s[i++] = pb.peak;
  s[i++] = pb.max_drawdown;
  s[i++] = static_cast<double>(pb.max_long);
  s[i++] = static_cast<double>(pb.max_short);
  for (int h = 0; h < 3; ++h)                             // 30, 31, 32
    s[i++] = pb.markout_qty[h] ? pb.markout_sum[h] / static_cast<double>(pb.markout_qty[h]) : 0.0;
  s[i++] = pb.observed_seconds > 0 ? pb.two_sided_seconds / pb.observed_seconds : 0.0;
  s[i++] = pb.pnl_sum;
  s[i++] = pb.pnl_sum_sq;                                 // 35
  s[i++] = static_cast<double>(pb.pnl_samples);
  s[i++] = static_cast<double>(acct.volume);
  s[i++] = static_cast<double>(acct.maker_volume);
  s[i++] = acct.trades;
  s[i++] = bot.enabled ? 1 : 0;                           // 40
  s[i++] = bot.reservation;
  s[i++] = bot.half_spread;
  s[i++] = bot.bid;
  s[i++] = bot.ask;
  s[i++] = algo.active ? 1 : 0;                           // 45
  s[i++] = algo.side == Side::Buy ? 0 : 1;
  s[i++] = static_cast<double>(algo.target);
  s[i++] = static_cast<double>(algo.done);
  s[i++] = algo.arrival_mid;
  s[i++] = algo.avg_price;                                // 50
  s[i++] = algo.shortfall_ticks;
  s[i++] = static_cast<double>(m.bar_count());
  s[i++] = static_cast<double>(m.bar_base());
  s[i++] = static_cast<double>(m.tape_count());
  s[i++] = static_cast<double>(m.user_fill_count());      // 55
  s[i++] = static_cast<double>(m.event_count());
  s[i++] = m.flow();
  s[i++] = m.sigma_slow();
  s[i++] = m.config().taker_fee;
  s[i++] = m.config().maker_rebate;                       // 60
  s[i++] = m.vol_multiplier();
  return g_state;
}

int32_t* TF_EXPORT(tf_depth_ptr)() { return g_depth; }

/// Writes [price, qty, orders, user_qty] per level, best first. Returns the level count.
int TF_EXPORT(tf_depth)(int side, int max_levels) {
  static LevelView levels[kMaxDepth];
  const int n = g_market->book().depth(side_of(side), levels, std::min(max_levels, kMaxDepth));
  for (int i = 0; i < n; ++i) {
    g_depth[i * 4 + 0] = levels[i].price;
    g_depth[i * 4 + 1] = levels[i].qty;
    g_depth[i * 4 + 2] = levels[i].orders;
    g_depth[i * 4 + 3] = g_market->user_qty_at(levels[i].price);
  }
  return n;
}

/// Bars are 8 x int32: open, high, low, close, volume, buy volume, trades, halted.
const Bar* TF_EXPORT(tf_bars)(double from) {
  return g_market->bars(static_cast<int64_t>(from));
}

/// Samples are 8 x float32: mid, fundamental, user pnl, user position, sigma, spread, bot bid, bot ask.
const Sample* TF_EXPORT(tf_samples)(double from) {
  return g_market->samples(static_cast<int64_t>(from));
}

/// The bar still being built for the current second (same layout as tf_bars).
const Bar* TF_EXPORT(tf_live_bar)() { return &g_market->live_bar(); }

double* TF_EXPORT(tf_tape_ptr)() { return g_tape; }
int TF_EXPORT(tf_tape)(double from) {
  const int64_t end = g_market->tape_count();
  int64_t i = std::max<int64_t>(static_cast<int64_t>(from), end - Market::kTapeSize);
  int n = 0;
  for (; i < end; ++i, ++n) {
    const TapeEntry& t = g_market->tape_at(i);
    double* o = g_tape + n * 6;
    o[0] = t.time; o[1] = t.price; o[2] = t.qty; o[3] = t.taker_side; o[4] = t.taker_kind; o[5] = t.maker_kind;
  }
  return n;
}

double* TF_EXPORT(tf_fills_ptr)() { return g_fills; }
int TF_EXPORT(tf_fills)(double from) {
  const int64_t end = g_market->user_fill_count();
  int64_t i = std::max<int64_t>(static_cast<int64_t>(from), end - Market::kFillRing);
  int n = 0;
  for (; i < end; ++i, ++n) {
    const UserFill& f = g_market->user_fill_at(i);
    double* o = g_fills + n * 8;
    o[0] = f.time; o[1] = f.side; o[2] = f.price; o[3] = f.qty;
    o[4] = f.is_maker; o[5] = f.mid; o[6] = f.fee; o[7] = f.order_id;
  }
  return n;
}

double* TF_EXPORT(tf_events_ptr)() { return g_events; }
int TF_EXPORT(tf_events)(double from) {
  const int64_t end = g_market->event_count();
  int64_t i = std::max<int64_t>(static_cast<int64_t>(from), end - Market::kEventRing);
  int n = 0;
  for (; i < end; ++i, ++n) {
    const MarketEvent& e = g_market->event_at(i);
    double* o = g_events + n * 4;
    o[0] = e.time; o[1] = e.code; o[2] = e.a; o[3] = e.b;
  }
  return n;
}

double* TF_EXPORT(tf_orders_ptr)() { return g_orders; }
int TF_EXPORT(tf_orders)() {
  static UserOrder orders[kMaxUserOrders];
  const int n = g_market->user_orders(orders, kMaxUserOrders);
  for (int i = 0; i < n; ++i) {
    double* o = g_orders + i * 6;
    o[0] = orders[i].id; o[1] = orders[i].side; o[2] = orders[i].price;
    o[3] = orders[i].remaining; o[4] = orders[i].original; o[5] = orders[i].queue_ahead;
  }
  return n;
}

/// Per trader kind: traders, net position, P&L in ticks, volume, maker volume.
double* TF_EXPORT(tf_kinds)() {
  for (int k = 0; k < static_cast<int>(Kind::Count); ++k) {
    const Market::KindStats ks = g_market->kind_stats(static_cast<Kind>(k));
    double* o = g_kinds + k * 5;
    o[0] = ks.traders; o[1] = static_cast<double>(ks.position); o[2] = ks.pnl;
    o[3] = static_cast<double>(ks.volume); o[4] = static_cast<double>(ks.maker_volume);
  }
  return g_kinds;
}

// ------------------------------------------------------------ commands ----

double* TF_EXPORT(tf_limit)(int side, int price, int qty, int tif, int post_only) {
  return write_result(g_market->user_limit(side_of(side), price, qty,
                                           static_cast<TimeInForce>(tif), post_only != 0));
}

double* TF_EXPORT(tf_market)(int side, int qty) {
  return write_result(g_market->user_market(side_of(side), qty));
}

int TF_EXPORT(tf_cancel)(double id) {
  return g_market->user_cancel(static_cast<OrderId>(id)) ? 1 : 0;
}

int TF_EXPORT(tf_cancel_all)() { return g_market->user_cancel_all(); }

double* TF_EXPORT(tf_flatten)() { return write_result(g_market->user_flatten()); }

void TF_EXPORT(tf_algo)(int side, double qty, int style, double param) {
  g_market->user_algo(side_of(side), static_cast<int64_t>(qty), static_cast<AlgoStyle>(style), param);
}

void TF_EXPORT(tf_algo_cancel)() { g_market->user_algo_cancel(); }

void TF_EXPORT(tf_user_reset)() { g_market->user_reset(); }

void TF_EXPORT(tf_bot)(int enabled, double gamma, double kappa, double horizon, int size,
                       double max_inventory) {
  BotParams p;
  p.gamma = gamma;
  p.kappa = kappa;
  p.horizon = horizon;
  p.size = size;
  p.max_inventory = static_cast<int64_t>(max_inventory);
  g_market->set_bot(enabled != 0, p);
}

void TF_EXPORT(tf_news)(double fraction) { g_market->news(fraction); }
void TF_EXPORT(tf_crash)(double intensity) { g_market->flash_crash(intensity); }
void TF_EXPORT(tf_drought)(double seconds) { g_market->liquidity_drought(seconds); }
void TF_EXPORT(tf_whale)(int side, double qty, double seconds) {
  g_market->whale(side_of(side), static_cast<int64_t>(qty), seconds);
}
void TF_EXPORT(tf_fat_finger)(int side, double qty) {
  g_market->fat_finger(side_of(side), static_cast<int64_t>(qty));
}
void TF_EXPORT(tf_vol_burst)(double seconds, double multiple) {
  g_market->volatility_burst(seconds, multiple);
}

void TF_EXPORT(tf_dials)(double activity, double liquidity, double volatility, int momentum,
                         int informed) {
  Dials& d = g_market->dials();
  d.activity = std::clamp(activity, 0.05, 5.0);
  d.liquidity = std::clamp(liquidity, 0.05, 3.0);
  d.volatility = std::clamp(volatility, 0.0, 5.0);
  d.momentum = momentum != 0;
  d.informed = informed != 0;
}

void TF_EXPORT(tf_breaker)(int enabled, double band) { g_market->set_breaker(enabled != 0, band); }

// ----------------------------------------------------------- backtests ----
//
// Backtests build their own Market, so they never disturb the live one.

namespace {
std::string g_catalog;
std::vector<double> g_backtest;
constexpr int kBacktestHeader = 24;
}  // namespace

/// The strategy catalogue as UTF-8 JSON; length from tf_catalog_len().
const char* TF_EXPORT(tf_catalog)() {
  if (g_catalog.empty()) g_catalog = strategy_catalog_json();
  return g_catalog.c_str();
}
int TF_EXPORT(tf_catalog_len)() {
  tf_catalog();
  return static_cast<int>(g_catalog.size());
}

/// Run one backtest. Writes a header of kBacktestHeader doubles followed by
/// three series of n+1 samples each (equity $, position, mid $), where n is the
/// session length in seconds. Header: n, pnl, spread, inventory, fees, sharpe,
/// max drawdown, volume, trades, maker share, max position, time in market,
/// markout 1s, 5s, 30s, market move, seed.
double* TF_EXPORT(tf_backtest)(int strategy, double seed, double warmup, double duration, int scenario,
                               double scenario_at, double p0, double p1, double p2, double p3, double p4) {
  BacktestSpec spec;
  spec.seed = static_cast<uint64_t>(std::max(1.0, seed));
  spec.warmup = std::clamp(warmup, 0.0, 3600.0);
  spec.duration = std::clamp(duration, 10.0, 3600.0);
  spec.scenario = static_cast<ScenarioKind>(std::clamp(scenario, 0, static_cast<int>(ScenarioKind::Count) - 1));
  spec.scenario_at = scenario_at;
  const double params[kMaxStrategyParams] = {p0, p1, p2, p3, p4};
  const auto id = static_cast<StrategyId>(std::clamp(strategy, 0, static_cast<int>(StrategyId::Count) - 1));
  const BacktestResult r = run_backtest(id, params, spec);
  const BacktestMetrics& k = r.metrics;
  const size_t n = r.equity.size();
  g_backtest.assign(kBacktestHeader + 3 * n, 0.0);
  double* h = g_backtest.data();
  int i = 0;
  h[i++] = static_cast<double>(n - 1);
  h[i++] = k.pnl;
  h[i++] = k.spread;
  h[i++] = k.inventory;
  h[i++] = k.fees;
  h[i++] = k.sharpe;
  h[i++] = k.max_drawdown;
  h[i++] = static_cast<double>(k.volume);
  h[i++] = k.trades;
  h[i++] = k.maker_share;
  h[i++] = static_cast<double>(k.max_position);
  h[i++] = k.time_in_market;
  h[i++] = k.markout[0];
  h[i++] = k.markout[1];
  h[i++] = k.markout[2];
  h[i++] = k.market_move;
  h[i++] = static_cast<double>(spec.seed);
  std::copy(r.equity.begin(), r.equity.end(), h + kBacktestHeader);
  std::copy(r.position.begin(), r.position.end(), h + kBacktestHeader + n);
  std::copy(r.mid.begin(), r.mid.end(), h + kBacktestHeader + 2 * n);
  return h;
}

}  // extern "C"
