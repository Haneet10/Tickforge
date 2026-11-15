// A price-time priority limit order book and matching engine for one symbol.
//
// Layout
//   * Every price has a slot in a flat array of levels, so reaching a level is
//     one index, not a tree walk.
//   * Orders at a level form a doubly linked FIFO queue threaded through a
//     pooled array of orders. Links are 32-bit indices, not pointers, so the
//     pool can grow without invalidating anything.
//   * A PriceIndex bitmap per side finds the next occupied level in O(1).
//   * An order id carries its own pool slot in the low 20 bits and a sequence
//     number above that. Cancel is a bounds check and one compare; there is no
//     hash map. A stale id can never hit a recycled slot because the sequence
//     number will not match.
//
// Costs: add O(1), cancel O(1), match O(1) per fill.
#pragma once

#include <cstdint>
#include <vector>

#include "tf/price_index.hpp"
#include "tf/types.hpp"

namespace tf {

class OrderBook {
 public:
  struct Order {
    OrderId id = 0;
    uint32_t next = kNil;
    uint32_t prev = kNil;
    Price price = 0;
    Qty qty = 0;  // remaining
    TraderId trader = 0;
    Side side = Side::Buy;
    bool live = false;
  };

  OrderBook();

  /// Match an incoming order against the book and rest any GTC remainder.
  /// fills() and stp_cancels() describe what happened until the next call.
  Result submit(const NewOrder& order);

  /// Remove a resting order. Returns false if the id is unknown or already gone.
  bool cancel(OrderId id, Removed* out = nullptr);

  /// Shrink a resting order in place, keeping its queue position.
  /// new_qty must be in (0, current remaining). Use cancel() to remove.
  bool reduce(OrderId id, Qty new_qty);

  const std::vector<Fill>& fills() const { return fills_; }
  /// Resting orders cancelled by self-trade prevention during the last submit.
  const std::vector<Removed>& stp_cancels() const { return stp_cancels_; }

  Price best_bid() const { return best_bid_; }  // kNoPrice when the side is empty
  Price best_ask() const { return best_ask_; }
  bool has_bid() const { return best_bid_ != kNoPrice; }
  bool has_ask() const { return best_ask_ != kNoPrice; }

  Qty qty_at(Price p) const;
  int32_t orders_at(Price p) const;
  /// Shares available to a taker on `taker_side` at prices no worse than limit.
  int64_t available(Side taker_side, Price limit, TraderId exclude_trader, int64_t cap) const;

  /// Copy up to `max_levels` levels from the top of one side, best first.
  int depth(Side side, LevelView* out, int max_levels) const;

  const Order* find(OrderId id) const;
  uint32_t live_orders() const { return live_orders_; }
  uint64_t total_orders() const { return next_seq_ - 1; }

  /// Visit resting orders at one level in queue order. Used by tests and the UI.
  template <typename F>
  void for_each_at(Price p, F&& f) const {
    if (p < 1 || p > kMaxPrice) return;
    for (uint32_t i = levels_[p].head; i != kNil; i = pool_[i].next) f(pool_[i]);
  }

  /// Exhaustively verify internal consistency. O(live orders). For tests.
  bool check_invariants() const;

  static constexpr uint32_t kSlotBits = 20;
  static constexpr uint32_t kSlotMask = (1u << kSlotBits) - 1;
  static constexpr uint32_t kNil = 0xFFFFFFFFu;
  /// Slot value used in the id of an order that never rested.
  static constexpr uint32_t kNoSlot = kSlotMask;
  static constexpr uint32_t kMaxLiveOrders = kSlotMask;

 private:
  struct Level {
    uint32_t head = kNil;
    uint32_t tail = kNil;
    Qty qty = 0;
    int32_t count = 0;
  };

  uint32_t alloc();
  void release(uint32_t idx);
  void link_back(uint32_t idx);
  void unlink(uint32_t idx);  // detaches and fixes level, bitmap and best price
  void match(Side side, Price limit, TraderId trader, OrderId taker_id, Qty& remaining,
             int64_t& notional);

  std::vector<Level> levels_;
  std::vector<Order> pool_;
  uint32_t free_head_ = kNil;
  PriceIndex bids_;
  PriceIndex asks_;
  Price best_bid_ = kNoPrice;
  Price best_ask_ = kNoPrice;
  uint64_t next_seq_ = 1;
  uint32_t live_orders_ = 0;
  std::vector<Fill> fills_;
  std::vector<Removed> stp_cancels_;
};

}  // namespace tf
