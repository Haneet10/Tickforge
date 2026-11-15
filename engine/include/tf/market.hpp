// The simulated market: one order book, a population of trading agents, a
// hidden "fundamental value" they are all trying to find, and the bookkeeping
// that turns their trades into candles, a tape and per-trader P&L.
//
// Time is event driven. Every agent says when it next wants to act; step()
// pops those wake-ups in time order. Nothing depends on wall-clock time or on
// how the caller slices its step() calls, so a run is fully determined by its
// seed and by what the user does.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include "tf/order_book.hpp"
#include "tf/rng.hpp"
#include "tf/types.hpp"

namespace tf {

class Agent;
class MarketMaker;
class ExecutionAlgo;
class QuotingBot;

enum class Kind : uint8_t {
  User = 0,
  Retail = 1,       // uninformed order flow
  MarketMaker = 2,  // quotes both sides, earns the spread
  Momentum = 3,     // buys strength, sells weakness
  Value = 4,        // trades toward a noisy estimate of fair value
  Informed = 5,     // sees fair value exactly and acts first
  Institution = 6,  // large parent orders worked by an execution algorithm
  Count = 7,
};

struct Config {
  uint64_t seed = 1;
  Price initial_price = 10000;  // $100.00

  // Exchange fees in ticks per share. Takers pay, makers are paid a rebate.
  double taker_fee = 0.30;
  double maker_rebate = 0.20;

  // Fundamental value: mean-reverting random walk with stochastic volatility and jumps.
  double fund_vol = 1.0;            // ticks per sqrt(second)
  double fund_reversion = 1.0 / 900;  // pull toward the long-run level, per second
  double vol_of_vol = 0.5;         // stdev of log volatility
  double vol_half_life = 45.0;      // seconds
  double jump_rate = 1.0 / 150;     // news arrivals per second
  double jump_size = 12.0;          // stdev of a news jump, ticks

  // Population.
  int market_makers = 5;
  int momentum_traders = 3;
  int value_traders = 5;
  int informed_traders = 1;

  // Retail flow, events per second.
  double retail_limit_rate = 7.0;
  double retail_market_rate = 8.0;
  double retail_cancel_rate = 0.2;  // per resting order per second

  // Order-entry collars, as fractions of the last trade price.
  double price_band = 0.10;     // limit orders further away than this are rejected
  double market_collar = 0.02;  // a single market order cannot trade further than this

  // Circuit breaker (limit up / limit down).
  bool breaker_enabled = false;
  double breaker_band = 0.035;       // fraction away from the reference price
  double breaker_halt_seconds = 30;
};

/// Knobs the user can turn while the market runs.
struct Dials {
  double activity = 1.0;    // scales retail order flow
  double liquidity = 1.0;   // scales market-maker size and tightness
  double volatility = 1.0;  // scales fundamental volatility
  bool momentum = true;
  bool informed = true;
};

struct Account {
  int64_t position = 0;
  double cash = 0.0;  // ticks; positive after selling
  double fees = 0.0;  // ticks; net paid (negative means net rebates)
  int64_t volume = 0;
  int64_t maker_volume = 0;
  int32_t trades = 0;

  double equity(double mark) const { return cash + static_cast<double>(position) * mark - fees; }
};

struct Bar {
  Price open, high, low, close;
  int32_t volume;
  int32_t buy_volume;  // taker-buy volume
  int32_t trades;
  int32_t halted;      // 1 if trading was halted during this second
};

/// One per simulated second, parallel to the bars.
struct Sample {
  float mid;
  float fundamental;
  float user_pnl;
  float user_position;
  float sigma;      // short-horizon volatility, ticks per sqrt(second)
  float spread;
  float bot_bid;    // quoting bot's prices, 0 when not quoting
  float bot_ask;
};

struct TapeEntry {
  double time;  // seconds
  double price;
  double qty;
  double taker_side;  // 0 buy, 1 sell
  double taker_kind;
  double maker_kind;
};

struct UserFill {
  double time;
  double side;      // 0 buy, 1 sell
  double price;
  double qty;
  double is_maker;
  double mid;       // mid just before the trade
  double fee;       // ticks, negative for a rebate
  double order_id;
};

struct UserOrder {
  double id;
  double side;
  double price;
  double remaining;
  double original;
  double queue_ahead;  // shares in front of this order at its price
};

enum class EventCode : int32_t {
  Halt = 1,
  Resume = 2,
  ScenarioStart = 3,
  ScenarioEnd = 4,
  AlgoDone = 5,
};

struct MarketEvent {
  double time;
  double code;
  double a;
  double b;
};

/// Where the user's P&L came from. spread + inventory - fees == total, exactly.
struct PnlBreakdown {
  double total = 0;
  double spread = 0;     // edge versus mid at the moment of each fill
  double inventory = 0;  // position times subsequent moves in mid
  double fees = 0;
  double peak = 0;
  double max_drawdown = 0;
  int64_t max_long = 0;
  int64_t max_short = 0;
  // Average markouts in ticks per share: how far the mid moved in the user's
  // favour 1, 5 and 30 seconds after each fill. Negative means adverse selection.
  std::array<double, 3> markout_sum{};
  std::array<int64_t, 3> markout_qty{};
  double two_sided_seconds = 0;  // time with both a bid and an ask resting
  double observed_seconds = 0;
  double pnl_sum = 0;            // for the Sharpe of one-second P&L changes
  double pnl_sum_sq = 0;
  int64_t pnl_samples = 0;
};

enum class AlgoStyle : uint8_t { Twap = 0, Pov = 1, Sweep = 2 };

struct AlgoStatus {
  bool active = false;
  Side side = Side::Buy;
  int64_t target = 0;
  int64_t done = 0;
  double arrival_mid = 0;
  double avg_price = 0;
  double shortfall_ticks = 0;  // per share, positive is a cost
};

struct BotParams {
  double gamma = 0.05;     // risk aversion
  double kappa = 0.7;      // how fast fill probability decays with distance, per tick
  double horizon = 10.0;   // seconds
  Qty size = 100;
  int64_t max_inventory = 1000;
};

struct BotStatus {
  bool enabled = false;
  double reservation = 0;
  double half_spread = 0;
  Price bid = 0;
  Price ask = 0;
};

class Market {
 public:
  explicit Market(const Config& config = {});
  ~Market();
  Market(const Market&) = delete;
  Market& operator=(const Market&) = delete;

  /// Advance simulated time by dt microseconds.
  void step(Time dt);

  // ------------------------------------------------------- order entry ----
  Result submit(const NewOrder& order);
  bool cancel(OrderId id);

  Result user_limit(Side side, Price price, Qty qty, TimeInForce tif, bool post_only);
  Result user_market(Side side, Qty qty);
  bool user_cancel(OrderId id);
  int user_cancel_all();
  /// Close the user's position with a market order.
  Result user_flatten();
  /// Work a large user order with an execution algorithm.
  void user_algo(Side side, int64_t qty, AlgoStyle style, double seconds_or_rate);
  void user_algo_cancel();
  /// Zero the user's account and statistics (the market keeps running).
  void user_reset();

  void set_bot(bool enabled, const BotParams& params);
  BotStatus bot_status() const;
  AlgoStatus user_algo_status() const;

  // --------------------------------------------------------- scenarios ----
  /// Jump the fundamental value by a fraction, e.g. -0.02 for bad news.
  void news(double fraction);
  /// A large seller dumps stock as a share of volume, with no price limit.
  void flash_crash(double intensity);
  /// Market makers step back for a while.
  void liquidity_drought(double seconds);
  /// An institution buys or sells a block over time.
  void whale(Side side, int64_t qty, double seconds);
  /// One oversized market order.
  void fat_finger(Side side, int64_t qty);
  void volatility_burst(double seconds, double multiple);

  Dials& dials() { return dials_; }
  const Dials& dials() const { return dials_; }
  void set_breaker(bool enabled, double band);

  // ------------------------------------------------------------- state ----
  Time now() const { return now_; }
  double seconds() const { return static_cast<double>(now_) * 1e-6; }
  const OrderBook& book() const { return book_; }
  const Config& config() const { return cfg_; }

  /// Mid price; falls back to the last trade when a side is empty.
  double mid() const;
  /// Size-weighted mid: leans toward the side with less resting size.
  double microprice() const;
  Price last() const { return last_; }
  double fundamental() const { return fund_; }
  double sigma() const { return sigma_fast_; }
  double sigma_slow() const { return sigma_slow_; }
  /// Signed taker volume, exponentially decayed (shares, + is buying pressure).
  double flow() const { return flow_ema_; }
  /// Signed taker volume since the start (shares).
  double cumulative_flow() const { return cum_flow_; }
  bool halted() const { return now_ < halt_until_; }
  double halt_remaining() const;
  double liquidity_factor() const;
  double vol_multiplier() const;

  const Account& account(TraderId t) const { return accounts_[t]; }
  Kind kind_of(TraderId t) const { return kinds_[t]; }
  TraderId trader_count() const { return static_cast<TraderId>(accounts_.size()); }
  TraderId add_trader(Kind kind);

  const PnlBreakdown& user_pnl();
  int user_orders(UserOrder* out, int max) const;
  Qty user_qty_at(Price p) const;

  // Histories. Indices are absolute and only ever grow.
  int64_t bar_count() const { return bar_base_ + static_cast<int64_t>(bars_.size()); }
  int64_t bar_base() const { return bar_base_; }
  const Bar* bars(int64_t from) const { return bars_.data() + (from - bar_base_); }
  const Sample* samples(int64_t from) const { return samples_.data() + (from - bar_base_); }
  /// The bar for the second in progress.
  const Bar& live_bar() const { return cur_; }

  int64_t tape_count() const { return tape_count_; }
  const TapeEntry& tape_at(int64_t index) const { return tape_[index % kTapeSize]; }
  int64_t user_fill_count() const { return user_fill_count_; }
  const UserFill& user_fill_at(int64_t index) const { return user_fills_[index % kFillRing]; }
  int64_t event_count() const { return event_count_; }
  const MarketEvent& event_at(int64_t index) const { return events_[index % kEventRing]; }

  int64_t total_volume() const { return volume_; }
  int64_t total_trades() const { return trades_; }
  /// Orders, cancels and fills handled by the matching engine so far.
  uint64_t messages() const { return messages_; }
  double vwap() const { return volume_ ? notional_ / static_cast<double>(volume_) : mid(); }
  Price session_high() const { return high_; }
  Price session_low() const { return low_; }
  Price session_open() const { return cfg_.initial_price; }

  struct KindStats {
    int traders = 0;
    int64_t position = 0;
    double pnl = 0;
    int64_t volume = 0;
    int64_t maker_volume = 0;
  };
  KindStats kind_stats(Kind k) const;

  static constexpr int kTapeSize = 512;
  static constexpr int kFillRing = 1024;
  static constexpr int kEventRing = 64;

  // For agents.
  Rng& rng() { return rng_; }
  void schedule(Agent* agent, Time delay);
  void push_event(EventCode code, double a = 0, double b = 0);

 private:
  struct Wake {
    Time at;
    uint64_t seq;
    Agent* agent;
    bool operator>(const Wake& o) const { return at != o.at ? at > o.at : seq > o.seq; }
  };
  struct PendingMarkout {
    Time due;
    double price;
    int32_t qty;
    int8_t dir;
    int8_t horizon;
  };

  void process_fills(double pre_mid);
  void record_trade(const Fill& f);
  void mark_user(double mark);
  void tick_housekeeping();   // every 100 ms: fundamental, volatility, breaker
  void roll_bars();
  void close_second();
  void check_breaker(Price trade_price);
  template <typename T, typename... Args>
  T* add_agent(Args&&... args);

  Config cfg_;
  Dials dials_;
  OrderBook book_;
  Rng rng_;
  Time now_ = 0;
  uint64_t wake_seq_ = 0;
  std::vector<Wake> heap_;
  std::vector<std::unique_ptr<Agent>> agents_;
  std::vector<Account> accounts_;
  std::vector<Kind> kinds_;

  // Fundamental process.
  double fund_;
  double fund_anchor_;
  double log_vol_ = 0.0;
  Time next_tick_ = 0;
  Time vol_burst_until_ = 0;
  double vol_burst_mult_ = 1.0;
  Time drought_until_ = 0;

  // Market statistics.
  Price last_;
  Price high_, low_;
  int64_t volume_ = 0;
  int64_t trades_ = 0;
  double notional_ = 0;
  uint64_t messages_ = 0;
  double prev_mid_ = 0;
  double var_fast_ = 1.0;
  double var_slow_ = 1.0;
  double sigma_fast_ = 1.0;
  double sigma_slow_ = 1.0;
  double flow_ema_ = 0;
  double cum_flow_ = 0;

  // Circuit breaker.
  Time halt_until_ = 0;
  bool was_halted_ = false;
  double ref_sum_ = 0;  // rolling sum of the last kRefWindow closes
  static constexpr int kRefWindow = 120;

  // Histories.
  std::vector<Bar> bars_;
  std::vector<Sample> samples_;
  int64_t bar_base_ = 0;
  Bar cur_{};
  Time bar_end_ = kSecond;
  std::array<TapeEntry, kTapeSize> tape_{};
  int64_t tape_count_ = 0;
  std::array<UserFill, kFillRing> user_fills_{};
  int64_t user_fill_count_ = 0;
  std::array<MarketEvent, kEventRing> events_{};
  int64_t event_count_ = 0;

  // User analytics.
  std::vector<OrderId> user_open_;
  std::vector<Qty> user_open_original_;
  PnlBreakdown pnl_;
  double user_mark_ = 0;
  double last_sample_pnl_ = 0;
  std::vector<PendingMarkout> markouts_;
  size_t markout_head_ = 0;

  QuotingBot* bot_ = nullptr;
  ExecutionAlgo* user_algo_ = nullptr;
  ExecutionAlgo* institution_ = nullptr;
  std::vector<MarketMaker*> makers_;
  int active_scenarios_ = 0;
};

}  // namespace tf
