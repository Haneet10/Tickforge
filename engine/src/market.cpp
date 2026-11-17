#include "tf/market.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

#include "tf/agents.hpp"

namespace tf {

namespace {

constexpr Time kTick = 100 * kMillisecond;  // housekeeping period
constexpr double kTickSeconds = 0.1;
constexpr Time kMarkoutHorizons[3] = {1 * kSecond, 5 * kSecond, 30 * kSecond};
constexpr size_t kMaxHistory = 400'000;

}  // namespace

template <typename T, typename... Args>
T* Market::add_agent(Args&&... args) {
  auto owned = std::make_unique<T>(std::forward<Args>(args)...);
  T* raw = owned.get();
  agents_.push_back(std::move(owned));
  return raw;
}

Market::Market(const Config& config)
    : cfg_(config),
      rng_(Rng::stream(config.seed, 0)),
      fund_(config.initial_price),
      fund_anchor_(config.initial_price),
      last_(config.initial_price),
      high_(config.initial_price),
      low_(config.initial_price) {
  heap_.reserve(64);
  bars_.reserve(8192);
  samples_.reserve(8192);
  prev_mid_ = last_;
  user_mark_ = last_;
  cur_ = {last_, last_, last_, last_, 0, 0, 0, 0};
  next_tick_ = kTick;

  uint64_t stream = 1;
  auto next_rng = [&] { return Rng::stream(cfg_.seed, stream++); };
  auto start = [&](Agent* a) { schedule(a, static_cast<Time>(rng_.uniform(1, 400) * kMillisecond)); };

  add_trader(Kind::User);  // trader 0

  // The user's tools. Dormant until switched on.
  bot_ = add_agent<QuotingBot>(*this, next_rng());
  user_algo_ = add_agent<ExecutionAlgo>(*this, next_rng(), TraderId{0});

  // Retail flow arrives once the dealers have had time to post their first quotes.
  schedule(add_agent<RetailFlow>(*this, next_rng(), 48), 1500 * kMillisecond);

  // Market makers range from a tight, fast, small dealer to a wide, slow, large one.
  for (int i = 0; i < cfg_.market_makers; ++i) {
    const double t = cfg_.market_makers > 1 ? static_cast<double>(i) / (cfg_.market_makers - 1) : 0.0;
    MakerParams p;
    p.half_spread = 1.1 + 1.6 * t;
    p.vol_coef = 0.7 + 0.5 * t;
    p.skew = 0.6 - 0.2 * t;
    p.impact = 0.011 - 0.003 * t;
    p.levels = 3 + (i % 3);
    p.level_step = 1 + (i % 2);
    p.size = static_cast<Qty>(40 + 35 * i);
    p.inventory_limit = static_cast<int64_t>(p.size) * 12;
    p.panic_sigma = 6.0 + 3.0 * t;
    p.interval = static_cast<Time>((70 + 60 * i) * kMillisecond);
    p.participation = static_cast<double>(i) / std::max(1, cfg_.market_makers);
    MarketMaker* mm = add_agent<MarketMaker>(*this, next_rng(), add_trader(Kind::MarketMaker), p);
    makers_.push_back(mm);
    start(mm);
  }

  for (int i = 0; i < cfg_.momentum_traders; ++i) {
    MomentumParams p;
    p.fast_seconds = 2.0 + 2.5 * i;
    p.slow_seconds = 12.0 + 14.0 * i;
    p.clip = static_cast<Qty>(50 + 20 * i);
    p.max_position = 500 + 250 * i;
    p.interval = static_cast<Time>((300 + 150 * i) * kMillisecond);
    start(add_agent<MomentumTrader>(*this, next_rng(), add_trader(Kind::Momentum), p));
  }

  for (int i = 0; i < cfg_.value_traders; ++i) {
    ValueParams p;
    p.noise = 4.0 + 2.5 * i;
    p.threshold = 2.5 + 0.8 * i;
    p.slope = 45.0 + 10.0 * i;
    p.clip = static_cast<Qty>(30 + 8 * i);
    p.interval = static_cast<Time>((600 + 220 * i) * kMillisecond);
    start(add_agent<ValueTrader>(*this, next_rng(), add_trader(Kind::Value), p, false));
  }

  for (int i = 0; i < cfg_.informed_traders; ++i) {
    ValueParams p;
    p.noise = 0.0;
    p.threshold = 3.0;
    p.slope = 100.0;
    p.max_position = 80000;
    p.clip = 40;
    p.aggression = 1.0;
    p.interval = 250 * kMillisecond;
    start(add_agent<ValueTrader>(*this, next_rng(), add_trader(Kind::Informed), p, true));
  }

  institution_ = add_agent<ExecutionAlgo>(*this, next_rng(), add_trader(Kind::Institution));
}

Market::~Market() = default;

TraderId Market::add_trader(Kind kind) {
  accounts_.emplace_back();
  kinds_.push_back(kind);
  return static_cast<TraderId>(accounts_.size() - 1);
}

// ------------------------------------------------------------ the clock ----

void Market::schedule(Agent* agent, Time delay) {
  if (agent->scheduled) return;
  agent->scheduled = true;
  heap_.push_back({now_ + std::max<Time>(delay, 1), wake_seq_++, agent});
  std::push_heap(heap_.begin(), heap_.end(), std::greater<Wake>());
}

void Market::step(Time dt) {
  const Time end = now_ + dt;
  for (;;) {
    const Time agent_at = heap_.empty() ? INT64_MAX : heap_.front().at;
    const Time next = std::min({agent_at, next_tick_, bar_end_});
    if (next > end) break;
    now_ = next;
    // Ties resolve in a fixed order so runs are reproducible.
    if (next == next_tick_) {
      tick_housekeeping();
      next_tick_ += kTick;
    } else if (next == bar_end_) {
      close_second();
    } else {
      std::pop_heap(heap_.begin(), heap_.end(), std::greater<Wake>());
      Agent* agent = heap_.back().agent;
      heap_.pop_back();
      agent->scheduled = false;
      const Time delay = agent->wake(now_);
      if (delay > 0) schedule(agent, delay);
    }
  }
  now_ = end;
}

void Market::tick_housekeeping() {
  // Fundamental value. Log volatility follows its own mean-reverting process,
  // which is what makes quiet and busy periods cluster.
  const double keep = std::exp(-kTickSeconds * 0.6931 / cfg_.vol_half_life);
  log_vol_ = keep * log_vol_ + cfg_.vol_of_vol * std::sqrt(1.0 - keep * keep) * rng_.normal();
  const double vol = cfg_.fund_vol * vol_multiplier() * std::exp(log_vol_);
  fund_ += cfg_.fund_reversion * (fund_anchor_ - fund_) * kTickSeconds +
           vol * std::sqrt(kTickSeconds) * rng_.normal();
  if (rng_.chance(cfg_.jump_rate * kTickSeconds * dials_.volatility)) {
    const double jump = rng_.normal(0.0, cfg_.jump_size * dials_.volatility);
    fund_ += jump;
    fund_anchor_ += jump;  // news is permanent
  }
  fund_anchor_ = std::clamp(fund_anchor_, 2000.0, 40000.0);
  fund_ = std::clamp(fund_, 500.0, 60000.0);

  // Realised volatility of the mid, two horizons.
  const double m = mid();
  const double r2 = (m - prev_mid_) * (m - prev_mid_) / kTickSeconds;
  prev_mid_ = m;
  var_fast_ += (kTickSeconds / 4.0) * (r2 - var_fast_);
  var_slow_ += (kTickSeconds / 60.0) * (r2 - var_slow_);
  sigma_fast_ = std::sqrt(var_fast_);
  sigma_slow_ = std::sqrt(var_slow_);
  flow_ema_ *= std::exp(-kTickSeconds / 3.0);

  // Markouts that have come due.
  while (markout_head_ < markouts_.size() && markouts_[markout_head_].due <= now_) {
    const PendingMarkout& pm = markouts_[markout_head_++];
    pnl_.markout_sum[pm.horizon] += pm.dir * (m - pm.price) * pm.qty;
    pnl_.markout_qty[pm.horizon] += pm.qty;
  }
  if (markout_head_ > 4096 && markout_head_ * 2 > markouts_.size()) {
    markouts_.erase(markouts_.begin(), markouts_.begin() + static_cast<std::ptrdiff_t>(markout_head_));
    markout_head_ = 0;
  }

  if (!halted()) {
    if (was_halted_) {
      was_halted_ = false;
      push_event(EventCode::Resume);
    }
    bool has_bid = false, has_ask = false;
    for (OrderId id : user_open_) {
      if (const auto* o = book_.find(id)) (o->side == Side::Buy ? has_bid : has_ask) = true;
    }
    pnl_.observed_seconds += kTickSeconds;
    if (has_bid && has_ask) pnl_.two_sided_seconds += kTickSeconds;
  }
}

void Market::close_second() {
  if (halted()) cur_.halted = 1;
  bars_.push_back(cur_);

  const PnlBreakdown& pb = user_pnl();
  const BotStatus bs = bot_status();
  Sample s;
  s.mid = static_cast<float>(mid());
  s.fundamental = static_cast<float>(fund_);
  s.user_pnl = static_cast<float>(pb.total);
  s.user_position = static_cast<float>(accounts_[0].position);
  s.sigma = static_cast<float>(sigma_fast_);
  s.spread = (book_.has_bid() && book_.has_ask())
                 ? static_cast<float>(book_.best_ask() - book_.best_bid()) : 0.0f;
  s.bot_bid = bs.enabled ? static_cast<float>(bs.bid) : 0.0f;
  s.bot_ask = bs.enabled ? static_cast<float>(bs.ask) : 0.0f;
  samples_.push_back(s);

  const double d = pb.total - last_sample_pnl_;
  last_sample_pnl_ = pb.total;
  pnl_.pnl_sum += d;
  pnl_.pnl_sum_sq += d * d;
  pnl_.pnl_samples += 1;

  // Rolling reference price for the circuit breaker.
  ref_sum_ += cur_.close;
  if (bars_.size() > static_cast<size_t>(kRefWindow))
    ref_sum_ -= bars_[bars_.size() - 1 - kRefWindow].close;

  if (bars_.size() > kMaxHistory) {
    const auto drop = static_cast<std::ptrdiff_t>(kMaxHistory / 2);
    bars_.erase(bars_.begin(), bars_.begin() + drop);
    samples_.erase(samples_.begin(), samples_.begin() + drop);
    bar_base_ += drop;
  }

  cur_ = {last_, last_, last_, last_, 0, 0, 0, halted() ? 1 : 0};
  bar_end_ += kSecond;
}

// ----------------------------------------------------------- order flow ----

Result Market::submit(const NewOrder& order) {
  if (halted()) {
    Result r;
    r.reject = Reject::Halted;
    return r;
  }
  // Exchange risk controls. Limit orders priced far from the market are
  // refused, and a market order is not allowed to trade through more than a
  // few percent of the book in one go. Real exchanges apply the same kind of
  // collars; without them one order in a thin book can print an absurd price.
  NewOrder checked = order;
  const double band = cfg_.price_band * last_;
  if (order.type == OrderType::Limit) {
    if (std::abs(order.price - last_) > band) {
      Result r;
      r.reject = Reject::BadPrice;
      return r;
    }
  } else {
    const double collar = cfg_.market_collar * last_;
    checked.type = OrderType::Limit;
    if (checked.tif == TimeInForce::GTC) checked.tif = TimeInForce::IOC;
    checked.price = static_cast<Price>(std::clamp(
        order.side == Side::Buy ? std::ceil(last_ + collar) : std::floor(last_ - collar), 1.0,
        static_cast<double>(kMaxPrice)));
  }
  const double pre_mid = mid();
  const Result r = book_.submit(checked);
  ++messages_;
  if (!book_.fills().empty() || !book_.stp_cancels().empty()) process_fills(pre_mid);
  if (order.trader == 0 && r.resting > 0) {
    user_open_.push_back(r.id);
    user_open_original_.push_back(order.qty);
  }
  return r;
}

bool Market::cancel(OrderId id) {
  ++messages_;
  return book_.cancel(id);
}

void Market::process_fills(double pre_mid) {
  auto forget_user_order = [&](OrderId id) {
    for (size_t i = 0; i < user_open_.size(); ++i) {
      if (user_open_[i] != id) continue;
      user_open_.erase(user_open_.begin() + static_cast<std::ptrdiff_t>(i));
      user_open_original_.erase(user_open_original_.begin() + static_cast<std::ptrdiff_t>(i));
      return;
    }
  };

  for (const Removed& gone : book_.stp_cancels())
    if (gone.trader == 0) forget_user_order(gone.id);

  // Mark the user's position to the pre-trade mid before any fill changes it,
  // so the split between spread and inventory P&L stays exact.
  mark_user(pre_mid);
  for (const Fill& f : book_.fills()) {
    ++messages_;
    const int dir = sign(f.taker_side);  // +1: taker bought, maker sold
    const double value = static_cast<double>(f.price) * f.qty;

    Account& taker = accounts_[f.taker];
    taker.position += dir * f.qty;
    taker.cash -= dir * value;
    taker.fees += cfg_.taker_fee * f.qty;
    taker.volume += f.qty;
    taker.trades += 1;

    Account& maker = accounts_[f.maker];
    maker.position -= dir * f.qty;
    maker.cash += dir * value;
    maker.fees -= cfg_.maker_rebate * f.qty;
    maker.volume += f.qty;
    maker.maker_volume += f.qty;
    maker.trades += 1;

    record_trade(f);

    if (f.taker == 0 || f.maker == 0) {
      const bool is_maker = f.maker == 0;
      const int user_dir = is_maker ? -dir : dir;
      pnl_.spread += user_dir * (pre_mid - f.price) * f.qty;
      pnl_.max_long = std::max(pnl_.max_long, accounts_[0].position);
      pnl_.max_short = std::min(pnl_.max_short, accounts_[0].position);
      const double fee = is_maker ? -cfg_.maker_rebate * f.qty : cfg_.taker_fee * f.qty;
      user_fills_[user_fill_count_++ % kFillRing] = {
          seconds(), user_dir > 0 ? 0.0 : 1.0, static_cast<double>(f.price),
          static_cast<double>(f.qty), is_maker ? 1.0 : 0.0, pre_mid, fee,
          static_cast<double>(is_maker ? f.maker_id : f.taker_id)};
      for (int h = 0; h < 3; ++h) {
        // Keep the queue ordered by due time: horizons are inserted shortest
        // first and each horizon's entries arrive in time order.
        PendingMarkout pm{now_ + kMarkoutHorizons[h], static_cast<double>(f.price), f.qty,
                          static_cast<int8_t>(user_dir), static_cast<int8_t>(h)};
        auto pos = std::upper_bound(
            markouts_.begin() + static_cast<std::ptrdiff_t>(markout_head_), markouts_.end(), pm,
            [](const PendingMarkout& a, const PendingMarkout& b) { return a.due < b.due; });
        markouts_.insert(pos, pm);
      }
      if (is_maker && f.maker_remaining == 0) forget_user_order(f.maker_id);
    }
  }
}

void Market::record_trade(const Fill& f) {
  last_ = f.price;
  high_ = std::max(high_, f.price);
  low_ = std::min(low_, f.price);
  volume_ += f.qty;
  trades_ += 1;
  notional_ += static_cast<double>(f.price) * f.qty;
  flow_ema_ += sign(f.taker_side) * f.qty;
  cum_flow_ += sign(f.taker_side) * f.qty;

  cur_.high = std::max(cur_.high, f.price);
  cur_.low = std::min(cur_.low, f.price);
  cur_.close = f.price;
  cur_.volume += f.qty;
  cur_.trades += 1;
  if (f.taker_side == Side::Buy) cur_.buy_volume += f.qty;

  tape_[tape_count_++ % kTapeSize] = {
      seconds(), static_cast<double>(f.price), static_cast<double>(f.qty),
      f.taker_side == Side::Buy ? 0.0 : 1.0, static_cast<double>(kinds_[f.taker]),
      static_cast<double>(kinds_[f.maker])};

  check_breaker(f.price);
}

void Market::check_breaker(Price trade_price) {
  if (!cfg_.breaker_enabled || halted() || bars_.size() < 20) return;
  const double n = static_cast<double>(std::min<size_t>(bars_.size(), kRefWindow));
  const double ref = ref_sum_ / n;
  if (std::abs(trade_price - ref) <= cfg_.breaker_band * ref) return;
  halt_until_ = now_ + static_cast<Time>(cfg_.breaker_halt_seconds * kSecond);
  was_halted_ = true;
  cur_.halted = 1;
  push_event(EventCode::Halt, trade_price, ref);
}

void Market::set_breaker(bool enabled, double band) {
  cfg_.breaker_enabled = enabled;
  if (band > 0) cfg_.breaker_band = band;
}

double Market::halt_remaining() const {
  return halted() ? static_cast<double>(halt_until_ - now_) * 1e-6 : 0.0;
}

void Market::push_event(EventCode code, double a, double b) {
  events_[event_count_++ % kEventRing] = {seconds(), static_cast<double>(code), a, b};
}

// --------------------------------------------------------------- prices ----

double Market::mid() const {
  if (book_.has_bid() && book_.has_ask()) return 0.5 * (book_.best_bid() + book_.best_ask());
  return last_;
}

double Market::microprice() const {
  if (!book_.has_bid() || !book_.has_ask()) return last_;
  const double qb = book_.qty_at(book_.best_bid());
  const double qa = book_.qty_at(book_.best_ask());
  return (book_.best_bid() * qa + book_.best_ask() * qb) / (qa + qb);
}

double Market::liquidity_factor() const {
  return dials_.liquidity * (now_ < drought_until_ ? 0.2 : 1.0);
}

double Market::vol_multiplier() const {
  return dials_.volatility * (now_ < vol_burst_until_ ? vol_burst_mult_ : 1.0);
}

// ----------------------------------------------------------------- user ----

Result Market::user_limit(Side side, Price price, Qty qty, TimeInForce tif, bool post_only) {
  return submit({0, side, OrderType::Limit, tif, post_only, price, qty});
}

Result Market::user_market(Side side, Qty qty) {
  return submit({0, side, OrderType::Market, TimeInForce::IOC, false, kNoPrice, qty});
}

bool Market::user_cancel(OrderId id) {
  for (size_t i = 0; i < user_open_.size(); ++i) {
    if (user_open_[i] != id) continue;
    user_open_.erase(user_open_.begin() + static_cast<std::ptrdiff_t>(i));
    user_open_original_.erase(user_open_original_.begin() + static_cast<std::ptrdiff_t>(i));
    return cancel(id);
  }
  return false;
}

int Market::user_cancel_all() {
  int n = 0;
  for (OrderId id : user_open_) n += cancel(id) ? 1 : 0;
  user_open_.clear();
  user_open_original_.clear();
  return n;
}

Result Market::user_flatten() {
  user_algo_->stop();
  user_cancel_all();
  const int64_t pos = accounts_[0].position;
  if (pos == 0) return {};
  return user_market(pos > 0 ? Side::Sell : Side::Buy, static_cast<Qty>(std::min<int64_t>(std::abs(pos), INT32_MAX)));
}

void Market::user_algo(Side side, int64_t qty, AlgoStyle style, double param) {
  user_algo_->start(side, qty, style, param, false);
}

void Market::user_algo_cancel() { user_algo_->stop(); }

AlgoStatus Market::user_algo_status() const { return user_algo_->status(); }

void Market::user_reset() {
  user_cancel_all();
  user_algo_->stop();
  accounts_[0] = {};
  pnl_ = {};
  markouts_.clear();
  markout_head_ = 0;
  user_mark_ = mid();
  last_sample_pnl_ = 0;
}

void Market::set_bot(bool enabled, const BotParams& params) {
  bot_->configure(enabled, params);
  if (enabled) schedule(bot_, 1);
}

BotStatus Market::bot_status() const { return bot_->status(); }

void Market::mark_user(double mark) {
  pnl_.inventory += static_cast<double>(accounts_[0].position) * (mark - user_mark_);
  user_mark_ = mark;
}

const PnlBreakdown& Market::user_pnl() {
  const double m = mid();
  mark_user(m);
  pnl_.fees = accounts_[0].fees;
  pnl_.total = accounts_[0].equity(m);
  pnl_.peak = std::max(pnl_.peak, pnl_.total);
  pnl_.max_drawdown = std::max(pnl_.max_drawdown, pnl_.peak - pnl_.total);
  return pnl_;
}

int Market::user_orders(UserOrder* out, int max) const {
  int n = 0;
  for (size_t i = 0; i < user_open_.size() && n < max; ++i) {
    const OrderBook::Order* o = book_.find(user_open_[i]);
    if (!o) continue;
    int64_t ahead = 0;
    bool reached = false;
    book_.for_each_at(o->price, [&](const OrderBook::Order& other) {
      if (other.id == o->id) reached = true;
      if (!reached) ahead += other.qty;
    });
    out[n++] = {static_cast<double>(o->id), o->side == Side::Buy ? 0.0 : 1.0,
                static_cast<double>(o->price), static_cast<double>(o->qty),
                static_cast<double>(user_open_original_[i]), static_cast<double>(ahead)};
  }
  return n;
}

Qty Market::user_qty_at(Price p) const {
  Qty q = 0;
  for (OrderId id : user_open_) {
    const OrderBook::Order* o = book_.find(id);
    if (o && o->price == p) q += o->qty;
  }
  return q;
}

// ------------------------------------------------------------ scenarios ----

void Market::news(double fraction) {
  const double jump = fraction * fund_;
  fund_ += jump;
  fund_anchor_ += jump;
  push_event(EventCode::ScenarioStart, 1, fraction);
}

void Market::flash_crash(double intensity) {
  institution_->start(Side::Sell, static_cast<int64_t>(32000 * intensity), AlgoStyle::Pov, 0.5, true);
  push_event(EventCode::ScenarioStart, 2, intensity);
}

void Market::liquidity_drought(double seconds) {
  drought_until_ = now_ + static_cast<Time>(seconds * kSecond);
  push_event(EventCode::ScenarioStart, 3, seconds);
}

void Market::whale(Side side, int64_t qty, double seconds) {
  institution_->start(side, qty, AlgoStyle::Twap, seconds, true);
  push_event(EventCode::ScenarioStart, 4, side == Side::Buy ? 1 : -1);
}

void Market::fat_finger(Side side, int64_t qty) {
  institution_->start(side, qty, AlgoStyle::Sweep, 0, true);
  push_event(EventCode::ScenarioStart, 5, side == Side::Buy ? 1 : -1);
}

void Market::volatility_burst(double seconds, double multiple) {
  vol_burst_until_ = now_ + static_cast<Time>(seconds * kSecond);
  vol_burst_mult_ = multiple;
  push_event(EventCode::ScenarioStart, 6, seconds);
}

Market::KindStats Market::kind_stats(Kind k) const {
  KindStats s;
  const double m = mid();
  for (size_t i = 0; i < accounts_.size(); ++i) {
    if (kinds_[i] != k) continue;
    const Account& a = accounts_[i];
    s.traders += 1;
    s.position += a.position;
    s.pnl += a.equity(m);
    s.volume += a.volume;
    s.maker_volume += a.maker_volume;
  }
  return s;
}

}  // namespace tf
