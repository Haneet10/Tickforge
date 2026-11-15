#include "tf/agents.hpp"

#include <algorithm>
#include <cmath>

namespace tf {

namespace {

NewOrder limit_order(TraderId t, Side s, Price p, Qty q, TimeInForce tif = TimeInForce::GTC,
                     bool post_only = false) {
  return {t, s, OrderType::Limit, tif, post_only, p, q};
}

NewOrder market_order(TraderId t, Side s, Qty q) {
  return {t, s, OrderType::Market, TimeInForce::IOC, false, kNoPrice, q};
}

Price clamp_price(double p) {
  return static_cast<Price>(std::clamp(p, 1.0, static_cast<double>(kMaxPrice)));
}

}  // namespace

// ============================================================ RetailFlow ====

RetailFlow::RetailFlow(Market& market, Rng rng, int accounts) : Agent(market, rng) {
  for (int i = 0; i < accounts; ++i) accounts_.push_back(m_.add_trader(Kind::Retail));
  resting_.reserve(2048);
}

Qty RetailFlow::draw_size() {
  // Mostly small, occasionally a block.
  Qty q = static_cast<Qty>(10 * (1 + rng_.geometric(0.35)));
  if (rng_.chance(0.04)) q *= 5;
  return std::min<Qty>(q, 1000);
}

TraderId RetailFlow::pick_account() {
  return accounts_[rng_.below(static_cast<uint32_t>(accounts_.size()))];
}

Time RetailFlow::wake(Time) {
  const Config& cfg = m_.config();
  const double activity = std::max(0.05, m_.dials().activity);
  const double limit_rate = cfg.retail_limit_rate * activity;
  const double market_rate = cfg.retail_market_rate * activity;
  const double cancel_rate = cfg.retail_cancel_rate * static_cast<double>(resting_.size());
  const double total = limit_rate + market_rate + cancel_rate;
  const Time next = static_cast<Time>(rng_.exponential(total) * kSecond) + 1;
  if (m_.halted()) return next;

  const OrderBook& book = m_.book();
  const double u = rng_.uniform() * total;

  if (u < cancel_rate) {
    const uint32_t k = rng_.below(static_cast<uint32_t>(resting_.size()));
    m_.cancel(resting_[k]);  // may already be gone; that is fine
    resting_[k] = resting_.back();
    resting_.pop_back();
    return next;
  }

  const Side side = rng_.chance(0.5) ? Side::Buy : Side::Sell;
  if (u < cancel_rate + market_rate) {
    m_.submit(market_order(pick_account(), side, draw_size()));
    return next;
  }

  // A limit order. Reference prices fall back to the last trade when a side is empty.
  const Price bid = book.has_bid() ? book.best_bid() : m_.last() - 1;
  const Price ask = book.has_ask() ? book.best_ask() : m_.last() + 1;
  const Price spread = std::max<Price>(ask - bid, 1);
  Price price;
  if (spread > 1 && rng_.chance(0.3)) {
    // Step inside the spread.
    const Price improve = static_cast<Price>(1 + rng_.below(static_cast<uint32_t>(spread - 1)));
    price = side == Side::Buy ? bid + improve : ask - improve;
  } else {
    // Join the queue or sit behind it. Distance has a fat tail.
    const Price back = static_cast<Price>(rng_.power_law(1.6, 80));
    price = side == Side::Buy ? bid - back : ask + back;
  }
  if (price < 1 || price > kMaxPrice) return next;
  const Result r = m_.submit(limit_order(pick_account(), side, price, draw_size()));
  if (r.resting > 0) resting_.push_back(r.id);
  return next;
}

// =========================================================== MarketMaker ====

MarketMaker::MarketMaker(Market& market, Rng rng, TraderId id, const MakerParams& params)
    : Agent(market, rng), id_(id), p_(params) {}

void MarketMaker::cancel_side(std::vector<Quote>& side) {
  for (const Quote& q : side) m_.cancel(q.id);
  side.clear();
}

void MarketMaker::cancel_all() {
  cancel_side(bids_);
  cancel_side(asks_);
}

void MarketMaker::sync_side(Side side, std::vector<Quote>& live, Price top, Qty size) {
  const OrderBook& book = m_.book();
  const int dir = side == Side::Buy ? -1 : 1;  // deeper levels are further from mid
  // Drop quotes that were filled, are badly depleted, or are no longer wanted.
  // Quotes that are still at a wanted price stay put and keep their queue position.
  size_t kept = 0;
  bool wanted[8] = {};
  for (const Quote& q : live) {
    const OrderBook::Order* o = book.find(q.id);
    if (!o) continue;
    const int steps = (q.price - top) * dir;
    const bool on_grid = steps >= 0 && steps % p_.level_step == 0 && steps / p_.level_step < p_.levels;
    if (!on_grid || wanted[steps / p_.level_step] || o->qty * 5 < size * 2) {
      m_.cancel(q.id);
      continue;
    }
    wanted[steps / p_.level_step] = true;
    live[kept++] = q;
  }
  live.resize(kept);

  for (int level = 0; level < p_.levels; ++level) {
    if (wanted[level]) continue;
    const Price price = top + dir * level * p_.level_step;
    if (price < 1 || price > kMaxPrice) continue;
    const Qty q = size + (size * level) / 2;
    const Result r = m_.submit(limit_order(id_, side, price, q, TimeInForce::GTC, true));
    if (r.resting > 0) live.push_back({r.id, price});
  }
}

Time MarketMaker::wake(Time now) {
  const Time next = jitter(p_.interval);
  if (m_.halted()) return next;

  const double liq = m_.liquidity_factor();
  const double sigma = m_.sigma();

  // Step away when the market is too violent to quote, or when liquidity
  // conditions have pushed this dealer out.
  // After a pause it comes back with wide quotes and cannot panic again for a
  // while, otherwise an empty book would keep volatility high forever.
  if (sigma > p_.panic_sigma && now >= panic_allowed_) {
    paused_until_ = now + static_cast<Time>(rng_.uniform(1.5, 4.0) * kSecond);
    panic_allowed_ = paused_until_ + static_cast<Time>(rng_.uniform(8.0, 15.0) * kSecond);
  }
  if (now < paused_until_ || liq <= p_.participation) {
    cancel_all();
    has_fair_ = false;
    seen_flow_ = m_.cumulative_flow();
    // A dealer that steps away still has to respect its hard risk limit.
    const int64_t inv = m_.account(id_).position;
    if (std::abs(inv) > 2 * p_.inventory_limit)
      m_.submit(market_order(id_, inv > 0 ? Side::Sell : Side::Buy, p_.size));
    return next;
  }

  const OrderBook& book = m_.book();
  const double cum_flow = m_.cumulative_flow();
  if (!has_fair_) {
    fair_ = m_.mid();
    has_fair_ = true;
  } else {
    // Two things move the dealer's idea of fair value. Net taker flow since it
    // last looked: buyers lifting offers is evidence the price is too low, so
    // the estimate moves up in proportion (Kyle's lambda). And a weak pull
    // toward the market's own mid, so dealers do not drift apart.
    fair_ += p_.impact * (cum_flow - seen_flow_);
    fair_ += p_.consensus * (m_.mid() - fair_);
  }
  seen_flow_ = cum_flow;

  const int64_t inv = m_.account(id_).position;
  const double inv_clips = static_cast<double>(inv) / p_.size;
  const double tightness = std::sqrt(std::min(1.0, liq));
  const double half = (p_.half_spread + p_.vol_coef * std::clamp(sigma - 2.0, 0.0, 12.0)) / tightness;
  const double center = fair_ - p_.skew * inv_clips;

  Price bid = clamp_price(std::floor(center - half));
  Price ask = clamp_price(std::ceil(center + half));
  if (ask <= bid) ask = bid + 1;
  // Never quote through the other side of the book.
  if (book.has_ask() && bid >= book.best_ask()) bid = book.best_ask() - 1;
  if (book.has_bid() && ask <= book.best_bid()) ask = book.best_bid() + 1;

  const Qty size = std::max<Qty>(10, static_cast<Qty>(p_.size * std::clamp(liq, 0.25, 3.0)));

  if (inv >= p_.inventory_limit) cancel_side(bids_);
  else sync_side(Side::Buy, bids_, bid, size);
  if (inv <= -p_.inventory_limit) cancel_side(asks_);
  else sync_side(Side::Sell, asks_, ask, size);

  // Hard stop: far past the limit, pay the spread to cut the position. Dealers
  // passing inventory to each other like this is the "hot potato" seen in the
  // 2010 flash crash.
  if (std::abs(inv) > 2 * p_.inventory_limit)
    m_.submit(market_order(id_, inv > 0 ? Side::Sell : Side::Buy, p_.size));

  return next;
}

// ======================================================== MomentumTrader ====

MomentumTrader::MomentumTrader(Market& market, Rng rng, TraderId id, const MomentumParams& params)
    : Agent(market, rng), id_(id), p_(params) {}

Time MomentumTrader::wake(Time now) {
  const Time next = jitter(p_.interval);
  const double mid = m_.mid();
  if (last_ < 0) {
    fast_ = slow_ = mid;
    last_ = now;
    return next;
  }
  const double dt = static_cast<double>(now - last_) * 1e-6;
  last_ = now;
  fast_ += (1.0 - std::exp(-dt / p_.fast_seconds)) * (mid - fast_);
  slow_ += (1.0 - std::exp(-dt / p_.slow_seconds)) * (mid - slow_);
  if (m_.halted()) return next;

  const int64_t pos = m_.account(id_).position;
  if (!m_.dials().momentum) {
    // Switched off: just work out of any position.
    if (pos != 0)
      m_.submit(market_order(id_, pos > 0 ? Side::Sell : Side::Buy,
                             static_cast<Qty>(std::min<int64_t>(std::abs(pos), p_.clip))));
    return next;
  }

  // Trend strength in units of what volatility alone would produce.
  const double scale = std::max(0.5, m_.sigma_slow()) * std::sqrt(p_.slow_seconds);
  const double signal = (fast_ - slow_) / scale;

  if (signal > p_.entry && pos < p_.max_position) {
    m_.submit(market_order(id_, Side::Buy, p_.clip));
  } else if (signal < -p_.entry && pos > -p_.max_position) {
    m_.submit(market_order(id_, Side::Sell, p_.clip));
  } else if (std::abs(signal) < p_.exit && pos != 0) {
    const Qty q = static_cast<Qty>(std::min<int64_t>(std::abs(pos), p_.clip));
    m_.submit(market_order(id_, pos > 0 ? Side::Sell : Side::Buy, q));
  }
  return next;
}

// =========================================================== ValueTrader ====

ValueTrader::ValueTrader(Market& market, Rng rng, TraderId id, const ValueParams& params,
                         bool informed)
    : Agent(market, rng), id_(id), p_(params), informed_(informed) {
  error_ = p_.noise * rng_.normal();
}

Time ValueTrader::wake(Time) {
  const Time next = jitter(p_.interval);
  if (working_) {
    m_.cancel(working_);
    working_ = 0;
  }
  if (m_.halted()) return next;
  const int64_t pos = m_.account(id_).position;
  if (informed_ && !m_.dials().informed) {
    if (pos != 0)
      m_.submit(market_order(id_, pos > 0 ? Side::Sell : Side::Buy,
                             static_cast<Qty>(std::min<int64_t>(std::abs(pos), p_.clip))));
    return next;
  }

  // What this trader believes the stock is worth. The error is persistent:
  // someone who is too optimistic now is probably still too optimistic a second later.
  error_ = p_.noise_memory * error_ +
           p_.noise * std::sqrt(1.0 - p_.noise_memory * p_.noise_memory) * rng_.normal();
  const double estimate = m_.fundamental() + error_;
  const double edge = estimate - m_.mid();

  // Desired position grows with the mispricing beyond a dead zone.
  double target = 0;
  if (edge > p_.threshold) target = p_.slope * (edge - p_.threshold);
  else if (edge < -p_.threshold) target = p_.slope * (edge + p_.threshold);
  target = std::clamp(target, -static_cast<double>(p_.max_position), static_cast<double>(p_.max_position));

  const double gap = target - static_cast<double>(pos);
  if (std::abs(gap) < 10) return next;
  const Side side = gap > 0 ? Side::Buy : Side::Sell;
  const Qty qty = static_cast<Qty>(std::min<double>(std::abs(gap), p_.clip));
  const OrderBook& book = m_.book();

  const bool building = (gap > 0) == (edge > 0) && std::abs(edge) > p_.threshold;
  if (building && rng_.chance(p_.aggression)) {
    // Take liquidity, but never pay past the estimate less a margin for fees.
    const Price limit = side == Side::Buy ? clamp_price(std::floor(estimate - 1.0))
                                          : clamp_price(std::ceil(estimate + 1.0));
    m_.submit(limit_order(id_, side, limit, qty, TimeInForce::IOC));
  } else {
    // Rest at the touch and wait.
    if (!book.has_bid() || !book.has_ask()) return next;
    const Price price = side == Side::Buy ? book.best_bid() : book.best_ask();
    const Result r = m_.submit(limit_order(id_, side, price, qty, TimeInForce::GTC, true));
    if (r.resting > 0) working_ = r.id;
  }
  return next;
}

// ========================================================= ExecutionAlgo ====

ExecutionAlgo::ExecutionAlgo(Market& market, Rng rng, TraderId id) : Agent(market, rng), id_(id) {}

void ExecutionAlgo::start(Side side, int64_t qty, AlgoStyle style, double param, bool scenario) {
  if (qty <= 0) return;
  st_ = {};
  st_.active = true;
  st_.side = side;
  st_.target = qty;
  st_.arrival_mid = m_.mid();
  style_ = style;
  param_ = param;
  scenario_ = scenario;
  started_ = m_.now();
  volume_mark_ = m_.total_volume();
  notional_ = 0;
  m_.schedule(this, 1);
}

void ExecutionAlgo::stop() { st_.active = false; }

void ExecutionAlgo::finish() {
  st_.active = false;
  m_.push_event(scenario_ ? EventCode::ScenarioEnd : EventCode::AlgoDone,
                static_cast<double>(st_.done), st_.shortfall_ticks);
}

Time ExecutionAlgo::wake(Time now) {
  if (!st_.active) return 0;
  const Time period = 250 * kMillisecond;
  if (m_.halted()) return period;

  const int64_t left = st_.target - st_.done;
  int64_t slice = 0;
  switch (style_) {
    case AlgoStyle::Sweep:
      slice = left;
      break;
    case AlgoStyle::Twap: {
      const double elapsed = static_cast<double>(now - started_) * 1e-6 + 0.25;
      const double frac = param_ > 0 ? std::min(1.0, elapsed / param_) : 1.0;
      slice = static_cast<int64_t>(std::llround(frac * static_cast<double>(st_.target))) - st_.done;
      break;
    }
    case AlgoStyle::Pov: {
      // Trade a fixed share of everyone else's volume, with a floor so the
      // order always makes progress. There is no price limit: this is the
      // behaviour that turned a large sell order into the 2010 flash crash.
      const int64_t others = m_.total_volume() - volume_mark_;
      const double rate = std::clamp(param_, 0.01, 0.9);
      slice = std::max<int64_t>(static_cast<int64_t>(rate / (1.0 - rate) * static_cast<double>(others)), 60);
      break;
    }
  }
  slice = std::min(slice, left);
  if (slice > 0) {
    const Result r = m_.submit(market_order(id_, st_.side, static_cast<Qty>(std::min<int64_t>(slice, 1 << 30))));
    st_.done += r.filled;
    notional_ += static_cast<double>(r.notional);
    if (st_.done > 0) {
      st_.avg_price = notional_ / static_cast<double>(st_.done);
      st_.shortfall_ticks = sign(st_.side) * (st_.avg_price - st_.arrival_mid);
    }
  }
  volume_mark_ = m_.total_volume();

  const bool timed_out = style_ == AlgoStyle::Twap &&
                         static_cast<double>(now - started_) * 1e-6 > param_ + 30.0;
  if (st_.done >= st_.target || style_ == AlgoStyle::Sweep || timed_out) {
    finish();
    return 0;
  }
  return period;
}

// ============================================================ QuotingBot ====

QuotingBot::QuotingBot(Market& market, Rng rng) : Agent(market, rng) {}

void QuotingBot::configure(bool enabled, const BotParams& params) {
  p_ = params;
  p_.gamma = std::clamp(p_.gamma, 1e-4, 10.0);
  p_.kappa = std::clamp(p_.kappa, 0.01, 50.0);
  p_.size = std::max<Qty>(1, p_.size);
  if (st_.enabled && !enabled) pull();
  st_.enabled = enabled;
  if (!enabled) st_ = {};
}

void QuotingBot::pull() {
  if (bid_id_) m_.user_cancel(bid_id_);
  if (ask_id_) m_.user_cancel(ask_id_);
  bid_id_ = ask_id_ = 0;
  bid_at_ = ask_at_ = 0;
}

void QuotingBot::place(Side side, Price price, OrderId& id, Price& at) {
  const OrderBook::Order* live = id ? m_.book().find(id) : nullptr;
  // Leave a quote alone if it is still at the right price and not nearly used up.
  if (live && live->price == price && live->qty * 2 >= p_.size) return;
  if (live) m_.user_cancel(id);
  id = 0;
  at = 0;
  if (price < 1 || price > kMaxPrice) return;
  const Result r = m_.user_limit(side, price, p_.size, TimeInForce::GTC, true);
  if (r.resting > 0) {
    id = r.id;
    at = price;
  }
}

Time QuotingBot::wake(Time) {
  if (!st_.enabled) return 0;
  const Time next = 100 * kMillisecond;
  if (m_.halted()) return next;
  const OrderBook& book = m_.book();
  if (!book.has_bid() || !book.has_ask()) return next;

  const double sigma = std::max(0.3, 0.5 * (m_.sigma() + m_.sigma_slow()));
  const double risk = p_.gamma * sigma * sigma * p_.horizon;
  const int64_t pos = m_.account(0).position;
  const double q = static_cast<double>(pos) / p_.size;

  st_.reservation = m_.microprice() - q * risk;
  st_.half_spread = 0.5 * risk + std::log(1.0 + p_.gamma / p_.kappa) / p_.gamma;

  Price bid = clamp_price(std::floor(st_.reservation - st_.half_spread));
  Price ask = clamp_price(std::ceil(st_.reservation + st_.half_spread));
  if (ask <= bid) ask = bid + 1;
  // Passive only: never cross the spread to get rid of inventory.
  bid = std::min(bid, book.best_ask() - 1);
  ask = std::max(ask, book.best_bid() + 1);

  if (pos >= p_.max_inventory) {
    if (bid_id_) m_.user_cancel(bid_id_);
    bid_id_ = 0;
    bid_at_ = 0;
  } else {
    place(Side::Buy, bid, bid_id_, bid_at_);
  }
  if (pos <= -p_.max_inventory) {
    if (ask_id_) m_.user_cancel(ask_id_);
    ask_id_ = 0;
    ask_at_ = 0;
  } else {
    place(Side::Sell, ask, ask_id_, ask_at_);
  }
  st_.bid = bid_at_;
  st_.ask = ask_at_;
  return next;
}

}  // namespace tf
