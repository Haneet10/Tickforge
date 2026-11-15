// The trading population.
//
// Each agent is a small, legible model of one kind of market participant. None
// of them is told what the price should do. Candles, spreads, impact and
// crashes all emerge from these rules meeting each other in the order book.
#pragma once

#include <vector>

#include "tf/market.hpp"

namespace tf {

class Agent {
 public:
  Agent(Market& market, Rng rng) : m_(market), rng_(rng) {}
  virtual ~Agent() = default;

  /// Act, then return the delay until the next wake-up. Zero means "go
  /// dormant until someone schedules me again".
  virtual Time wake(Time now) = 0;

  bool scheduled = false;

 protected:
  Time jitter(Time mean, double spread = 0.4) {
    return static_cast<Time>(static_cast<double>(mean) * rng_.uniform(1.0 - spread, 1.0 + spread)) + 1;
  }

  Market& m_;
  Rng rng_;
};

/// Uninformed "retail" flow: limit orders scattered around the touch with a
/// power-law tail, market orders, and random cancellations. This is the
/// zero-intelligence model of Farmer, Patelli and Zovko (2005). It gives the
/// book a realistic shape and gives market makers someone to earn from.
class RetailFlow final : public Agent {
 public:
  RetailFlow(Market& market, Rng rng, int accounts);
  Time wake(Time now) override;

 private:
  Qty draw_size();
  TraderId pick_account();

  std::vector<TraderId> accounts_;
  std::vector<OrderId> resting_;
};

struct MakerParams {
  double half_spread = 1.2;   // ticks, in a calm market
  double vol_coef = 0.9;      // extra half spread per unit of excess volatility
  double skew = 0.5;          // ticks of quote shift per full clip of inventory
  double impact = 0.012;      // ticks of fair-value revision per share of net taker flow
  double consensus = 0.08;    // pull toward the market mid, per look
  int levels = 4;
  int level_step = 1;         // ticks between quote levels
  Qty size = 150;             // shares at the first level
  int64_t inventory_limit = 900;
  double panic_sigma = 7.0;   // pull quotes when short-term volatility exceeds this
  Time interval = 120 * kMillisecond;
  double participation = 0.0; // stays in the market while liquidity > this
};

/// A dealer. Quotes a ladder of bids and offers around its estimate of fair
/// value, leans the quotes against its inventory, widens when volatility
/// rises, and steps away entirely when it gets too violent.
class MarketMaker final : public Agent {
 public:
  MarketMaker(Market& market, Rng rng, TraderId id, const MakerParams& params);
  Time wake(Time now) override;

 private:
  struct Quote {
    OrderId id;
    Price price;
  };
  void cancel_all();
  void cancel_side(std::vector<Quote>& side);
  void sync_side(Side side, std::vector<Quote>& live, Price top, Qty size);

  TraderId id_;
  MakerParams p_;
  double fair_ = 0;
  double seen_flow_ = 0;
  bool has_fair_ = false;
  Time paused_until_ = 0;
  Time panic_allowed_ = 0;
  std::vector<Quote> bids_;
  std::vector<Quote> asks_;
};

struct MomentumParams {
  double fast_seconds = 3.0;
  double slow_seconds = 20.0;
  double entry = 1.2;      // signal threshold, in volatility units
  double exit = 0.25;
  Qty clip = 60;
  int64_t max_position = 600;
  Time interval = 400 * kMillisecond;
};

/// A trend follower. Compares a fast and a slow moving average of the mid and
/// trades in the direction of the gap. Momentum traders make moves overshoot.
class MomentumTrader final : public Agent {
 public:
  MomentumTrader(Market& market, Rng rng, TraderId id, const MomentumParams& params);
  Time wake(Time now) override;

 private:
  TraderId id_;
  MomentumParams p_;
  double fast_ = 0, slow_ = 0;
  Time last_ = -1;
};

struct ValueParams {
  double noise = 6.0;        // stdev of the trader's error about fair value, ticks
  double noise_memory = 0.98;  // persistence of that error between looks
  double threshold = 3.0;    // ignore mispricings smaller than this, ticks
  double slope = 60.0;       // shares of desired position per tick of mispricing
  int64_t max_position = 6000;
  Qty clip = 40;             // most it will trade per look
  double aggression = 0.2;   // probability of crossing the spread versus resting
  Time interval = 900 * kMillisecond;
};

/// A fundamental trader. Holds an estimate of what the stock is worth and
/// builds a position in proportion to how far the price is from it, a little
/// at a time. With zero noise and a short interval it becomes the informed
/// trader that picks off stale quotes after news.
class ValueTrader final : public Agent {
 public:
  ValueTrader(Market& market, Rng rng, TraderId id, const ValueParams& params, bool informed);
  Time wake(Time now) override;

 private:
  TraderId id_;
  ValueParams p_;
  bool informed_;
  double error_ = 0;
  OrderId working_ = 0;
};

/// Works a large parent order as a stream of small child orders.
///   TWAP  spreads the quantity evenly over a time window.
///   POV   trades a fixed share of market volume, whatever the price.
///   Sweep sends everything at once.
class ExecutionAlgo final : public Agent {
 public:
  ExecutionAlgo(Market& market, Rng rng, TraderId id);
  Time wake(Time now) override;

  void start(Side side, int64_t qty, AlgoStyle style, double param, bool scenario);
  void stop();
  AlgoStatus status() const { return st_; }
  TraderId trader() const { return id_; }

 private:
  void finish();

  TraderId id_;
  AlgoStatus st_;
  AlgoStyle style_ = AlgoStyle::Twap;
  double param_ = 0;
  bool scenario_ = false;
  Time started_ = 0;
  int64_t volume_mark_ = 0;
  double notional_ = 0;
};

/// The user's market-making bot: the Avellaneda-Stoikov (2008) model.
///
///   reservation price  r = mid - q * gamma * sigma^2 * T
///   half spread        d = gamma * sigma^2 * T / 2 + ln(1 + gamma / kappa) / gamma
///
/// q is inventory in clips. The bot quotes r - d and r + d, so it leans its
/// prices against whatever it is holding and widens when the market is wild.
class QuotingBot final : public Agent {
 public:
  QuotingBot(Market& market, Rng rng);
  Time wake(Time now) override;

  void configure(bool enabled, const BotParams& params);
  BotStatus status() const { return st_; }

 private:
  void pull();
  void place(Side side, Price price, OrderId& id, Price& at);

  BotParams p_;
  BotStatus st_;
  OrderId bid_id_ = 0, ask_id_ = 0;
  Price bid_at_ = 0, ask_at_ = 0;
};

}  // namespace tf
