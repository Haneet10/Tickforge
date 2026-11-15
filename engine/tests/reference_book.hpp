// The slow, obviously-correct order book the real one is checked against.
//
// It keeps every resting order in one std::vector and finds the next order to
// match by scanning all of them. Nothing here is clever, which is the point:
// if this and tf::OrderBook agree on millions of random operations, the fast
// one's linked lists, bitmaps and id scheme are doing the right thing.
#pragma once

#include <algorithm>
#include <vector>

#include "tf/types.hpp"

namespace ref {

using namespace tf;

struct RefOrder {
  uint64_t arrival;
  int handle;  // caller-chosen, stable across both books
  TraderId trader;
  Side side;
  Price price;
  Qty qty;
};

struct RefFill {
  int maker_handle;
  Price price;
  Qty qty;
  bool operator==(const RefFill& o) const {
    return maker_handle == o.maker_handle && price == o.price && qty == o.qty;
  }
};

class ReferenceBook {
 public:
  std::vector<RefFill> fills;
  std::vector<int> stp_cancelled;

  /// Returns the quantity left resting.
  Qty submit(int handle, const NewOrder& in, Status* status) {
    fills.clear();
    stp_cancelled.clear();
    const bool is_market = in.type == OrderType::Market;
    const bool buying = in.side == Side::Buy;
    if (in.qty <= 0 || (!is_market && (in.price < 1 || in.price > kMaxPrice))) {
      *status = Status::Rejected;
      return 0;
    }
    const Price limit = is_market ? (buying ? kMaxPrice : 1) : in.price;
    auto crossing = [&](const RefOrder& o) {
      return o.side != in.side && (buying ? o.price <= limit : o.price >= limit);
    };
    if (in.post_only && !is_market && std::any_of(orders_.begin(), orders_.end(), crossing)) {
      *status = Status::Rejected;
      return 0;
    }
    if (in.tif == TimeInForce::FOK) {
      int64_t avail = 0;
      for (const RefOrder& o : orders_)
        if (crossing(o) && o.trader != in.trader) avail += o.qty;
      if (avail < in.qty) {
        *status = Status::Rejected;
        return 0;
      }
    }

    Qty remaining = in.qty;
    while (remaining > 0) {
      // Best price first; among equal prices, the earliest arrival.
      int best = -1;
      for (int i = 0; i < static_cast<int>(orders_.size()); ++i) {
        if (!crossing(orders_[i])) continue;
        if (best < 0) { best = i; continue; }
        const RefOrder& a = orders_[i];
        const RefOrder& b = orders_[best];
        const bool better = buying ? a.price < b.price : a.price > b.price;
        if (better || (a.price == b.price && a.arrival < b.arrival)) best = i;
      }
      if (best < 0) break;
      RefOrder& m = orders_[best];
      if (m.trader == in.trader) {
        stp_cancelled.push_back(m.handle);
        orders_.erase(orders_.begin() + best);
        continue;
      }
      const Qty q = std::min(remaining, m.qty);
      fills.push_back({m.handle, m.price, q});
      remaining -= q;
      m.qty -= q;
      if (m.qty == 0) orders_.erase(orders_.begin() + best);
    }

    const Qty filled = in.qty - remaining;
    Qty resting = 0;
    if (remaining > 0 && !is_market && in.tif == TimeInForce::GTC) {
      orders_.push_back({next_arrival_++, handle, in.trader, in.side, in.price, remaining});
      resting = remaining;
    }
    if (remaining == 0) *status = Status::Filled;
    else if (filled > 0) *status = Status::Partial;
    else *status = resting > 0 ? Status::Resting : Status::Cancelled;
    return resting;
  }

  bool cancel(int handle) {
    auto it = find(handle);
    if (it == orders_.end()) return false;
    orders_.erase(it);
    return true;
  }

  bool reduce(int handle, Qty new_qty) {
    auto it = find(handle);
    if (it == orders_.end() || new_qty <= 0 || new_qty >= it->qty) return false;
    it->qty = new_qty;
    return true;
  }

  Price best_bid() const {
    Price p = kNoPrice;
    for (const RefOrder& o : orders_)
      if (o.side == Side::Buy && o.price > p) p = o.price;
    return p;
  }
  Price best_ask() const {
    Price p = kNoPrice;
    for (const RefOrder& o : orders_)
      if (o.side == Side::Sell && (p == kNoPrice || o.price < p)) p = o.price;
    return p;
  }
  Qty qty_at(Price p) const {
    Qty q = 0;
    for (const RefOrder& o : orders_)
      if (o.price == p) q += o.qty;
    return q;
  }
  size_t size() const { return orders_.size(); }
  const std::vector<RefOrder>& orders() const { return orders_; }

 private:
  std::vector<RefOrder>::iterator find(int handle) {
    return std::find_if(orders_.begin(), orders_.end(),
                        [&](const RefOrder& o) { return o.handle == handle; });
  }
  std::vector<RefOrder> orders_;
  uint64_t next_arrival_ = 1;
};

}  // namespace ref
