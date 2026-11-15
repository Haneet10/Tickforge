#include "tf/order_book.hpp"

#include <algorithm>

namespace tf {

OrderBook::OrderBook() : levels_(kPriceLevels) {
  pool_.reserve(4096);
  fills_.reserve(64);
}

// ---------------------------------------------------------------- pool ----

uint32_t OrderBook::alloc() {
  if (free_head_ != kNil) {
    const uint32_t idx = free_head_;
    free_head_ = pool_[idx].next;
    return idx;
  }
  if (pool_.size() >= kMaxLiveOrders) return kNil;
  pool_.emplace_back();
  return static_cast<uint32_t>(pool_.size() - 1);
}

void OrderBook::release(uint32_t idx) {
  Order& o = pool_[idx];
  o.live = false;
  o.id = 0;
  o.prev = kNil;
  o.next = free_head_;
  free_head_ = idx;
}

// --------------------------------------------------------------- queues ----

void OrderBook::link_back(uint32_t idx) {
  Order& o = pool_[idx];
  Level& lvl = levels_[o.price];
  o.next = kNil;
  o.prev = lvl.tail;
  if (lvl.tail != kNil) {
    pool_[lvl.tail].next = idx;
  } else {
    lvl.head = idx;
    if (o.side == Side::Buy) {
      bids_.set(o.price);
      if (o.price > best_bid_) best_bid_ = o.price;
    } else {
      asks_.set(o.price);
      if (best_ask_ == kNoPrice || o.price < best_ask_) best_ask_ = o.price;
    }
  }
  lvl.tail = idx;
  lvl.qty += o.qty;
  lvl.count += 1;
  live_orders_ += 1;
}

void OrderBook::unlink(uint32_t idx) {
  Order& o = pool_[idx];
  Level& lvl = levels_[o.price];
  if (o.prev != kNil) pool_[o.prev].next = o.next; else lvl.head = o.next;
  if (o.next != kNil) pool_[o.next].prev = o.prev; else lvl.tail = o.prev;
  lvl.qty -= o.qty;
  lvl.count -= 1;
  live_orders_ -= 1;
  if (lvl.head == kNil) {
    if (o.side == Side::Buy) {
      bids_.clear(o.price);
      if (o.price == best_bid_) best_bid_ = bids_.prev(o.price - 1);
    } else {
      asks_.clear(o.price);
      if (o.price == best_ask_) best_ask_ = asks_.next(o.price + 1);
    }
  }
}

// -------------------------------------------------------------- matching ----

void OrderBook::match(Side side, Price limit, TraderId trader, OrderId taker_id, Qty& remaining,
                      int64_t& notional) {
  const bool buying = side == Side::Buy;
  while (remaining > 0) {
    const Price px = buying ? best_ask_ : best_bid_;
    if (px == kNoPrice) break;
    if (buying ? px > limit : px < limit) break;

    // Walk the queue at the best price, oldest order first.
    uint32_t idx = levels_[px].head;
    while (idx != kNil && remaining > 0) {
      Order& maker = pool_[idx];
      const uint32_t next = maker.next;

      if (maker.trader == trader) {
        // Self-trade prevention: a participant never trades with itself. The
        // resting order is cancelled and the incoming one keeps going.
        stp_cancels_.push_back({maker.id, maker.trader, maker.side, maker.price, maker.qty});
        unlink(idx);
        release(idx);
        idx = next;
        continue;
      }

      const Qty q = std::min(remaining, maker.qty);
      remaining -= q;
      notional += static_cast<int64_t>(q) * px;
      fills_.push_back({maker.id, taker_id, maker.trader, trader, side, px, q, maker.qty - q});
      if (q == maker.qty) {
        unlink(idx);
        release(idx);
      } else {
        maker.qty -= q;
        levels_[px].qty -= q;
      }
      idx = next;
    }
    // If the level emptied, unlink() already advanced the best price.
  }
}

int64_t OrderBook::available(Side taker_side, Price limit, TraderId exclude_trader,
                             int64_t cap) const {
  int64_t total = 0;
  if (taker_side == Side::Buy) {
    for (Price p = best_ask_; p != kNoPrice && p <= limit && total < cap; p = asks_.next(p + 1)) {
      for (uint32_t i = levels_[p].head; i != kNil; i = pool_[i].next)
        if (pool_[i].trader != exclude_trader) total += pool_[i].qty;
    }
  } else {
    for (Price p = best_bid_; p != kNoPrice && p >= limit && total < cap; p = bids_.prev(p - 1)) {
      for (uint32_t i = levels_[p].head; i != kNil; i = pool_[i].next)
        if (pool_[i].trader != exclude_trader) total += pool_[i].qty;
    }
  }
  return total;
}

Result OrderBook::submit(const NewOrder& in) {
  fills_.clear();
  stp_cancels_.clear();

  Result r;
  if (in.qty <= 0) {
    r.reject = Reject::BadQuantity;
    return r;
  }
  const bool is_market = in.type == OrderType::Market;
  if (!is_market && (in.price < 1 || in.price > kMaxPrice)) {
    r.reject = Reject::BadPrice;
    return r;
  }
  const bool buying = in.side == Side::Buy;
  const Price limit = is_market ? (buying ? kMaxPrice : 1) : in.price;

  const bool crosses = buying ? (best_ask_ != kNoPrice && best_ask_ <= limit)
                              : (best_bid_ != kNoPrice && best_bid_ >= limit);
  if (in.post_only && !is_market && crosses) {
    r.reject = Reject::WouldCross;
    return r;
  }
  if (in.tif == TimeInForce::FOK && available(in.side, limit, in.trader, in.qty) < in.qty) {
    r.reject = Reject::Unfillable;
    return r;
  }

  const bool may_rest = !is_market && in.tif == TimeInForce::GTC;
  const uint64_t seq = next_seq_++;
  // The id is provisional until we know whether the order rests.
  const OrderId taker_id = (seq << kSlotBits) | kNoSlot;

  Qty remaining = in.qty;
  if (crosses) match(in.side, limit, in.trader, taker_id, remaining, r.notional);
  r.filled = in.qty - remaining;
  r.id = taker_id;

  if (remaining > 0 && may_rest) {
    const uint32_t idx = alloc();
    if (idx == kNil) {
      // Out of slots. Anything already traded stands; the remainder is dropped.
      r.status = r.filled > 0 ? Status::Partial : Status::Rejected;
      if (r.filled == 0) r.reject = Reject::BookFull;
      return r;
    }
    Order& o = pool_[idx];
    o.id = (seq << kSlotBits) | idx;
    o.price = in.price;
    o.qty = remaining;
    o.trader = in.trader;
    o.side = in.side;
    o.live = true;
    link_back(idx);
    r.id = o.id;
    r.resting = remaining;
    // Fills recorded during matching used the provisional id; point them at the real one.
    for (Fill& f : fills_) f.taker_id = o.id;
  }

  if (remaining == 0) r.status = Status::Filled;
  else if (r.filled > 0) r.status = Status::Partial;
  else r.status = r.resting > 0 ? Status::Resting : Status::Cancelled;
  return r;
}

bool OrderBook::cancel(OrderId id, Removed* out) {
  const uint32_t idx = static_cast<uint32_t>(id & kSlotMask);
  if (idx >= pool_.size()) return false;
  Order& o = pool_[idx];
  if (!o.live || o.id != id) return false;
  if (out) *out = {o.id, o.trader, o.side, o.price, o.qty};
  unlink(idx);
  release(idx);
  return true;
}

bool OrderBook::reduce(OrderId id, Qty new_qty) {
  const uint32_t idx = static_cast<uint32_t>(id & kSlotMask);
  if (idx >= pool_.size()) return false;
  Order& o = pool_[idx];
  if (!o.live || o.id != id) return false;
  if (new_qty <= 0 || new_qty >= o.qty) return false;
  levels_[o.price].qty -= o.qty - new_qty;
  o.qty = new_qty;
  return true;
}

// --------------------------------------------------------------- queries ----

const OrderBook::Order* OrderBook::find(OrderId id) const {
  const uint32_t idx = static_cast<uint32_t>(id & kSlotMask);
  if (idx >= pool_.size()) return nullptr;
  const Order& o = pool_[idx];
  return (o.live && o.id == id) ? &o : nullptr;
}

Qty OrderBook::qty_at(Price p) const {
  return (p < 1 || p > kMaxPrice) ? 0 : levels_[p].qty;
}

int32_t OrderBook::orders_at(Price p) const {
  return (p < 1 || p > kMaxPrice) ? 0 : levels_[p].count;
}

int OrderBook::depth(Side side, LevelView* out, int max_levels) const {
  int n = 0;
  if (side == Side::Buy) {
    for (Price p = best_bid_; p != kNoPrice && n < max_levels; p = bids_.prev(p - 1))
      out[n++] = {p, levels_[p].qty, levels_[p].count};
  } else {
    for (Price p = best_ask_; p != kNoPrice && n < max_levels; p = asks_.next(p + 1))
      out[n++] = {p, levels_[p].qty, levels_[p].count};
  }
  return n;
}

bool OrderBook::check_invariants() const {
  uint32_t live = 0;
  Price top_bid = kNoPrice, low_ask = kNoPrice;
  for (Price p = 1; p <= kMaxPrice; ++p) {
    const Level& lvl = levels_[p];
    const bool occupied = lvl.head != kNil;
    if (occupied != (lvl.tail != kNil)) return false;
    if (!occupied) {
      if (lvl.qty != 0 || lvl.count != 0) return false;
      if (bids_.test(p) || asks_.test(p)) return false;
      continue;
    }
    int64_t qty = 0;
    int32_t count = 0;
    uint32_t prev = kNil;
    const Side side = pool_[lvl.head].side;
    for (uint32_t i = lvl.head; i != kNil; i = pool_[i].next) {
      const Order& o = pool_[i];
      if (!o.live || o.price != p || o.side != side || o.qty <= 0) return false;
      if (o.prev != prev) return false;
      if ((o.id & kSlotMask) != i) return false;
      // Time priority: sequence numbers strictly increase along the queue.
      if (prev != kNil && (pool_[prev].id >> kSlotBits) >= (o.id >> kSlotBits)) return false;
      qty += o.qty;
      count += 1;
      prev = i;
    }
    if (prev != lvl.tail || qty != lvl.qty || count != lvl.count) return false;
    if (side == Side::Buy) {
      if (!bids_.test(p) || asks_.test(p)) return false;
      top_bid = p;
    } else {
      if (!asks_.test(p) || bids_.test(p)) return false;
      if (low_ask == kNoPrice) low_ask = p;
    }
    live += static_cast<uint32_t>(count);
  }
  if (live != live_orders_) return false;
  if (top_bid != best_bid_ || low_ask != best_ask_) return false;
  // The book is never crossed or locked.
  if (top_bid != kNoPrice && low_ask != kNoPrice && top_bid >= low_ask) return false;
  return true;
}

}  // namespace tf
