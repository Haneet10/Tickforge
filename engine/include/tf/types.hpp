// Core value types shared by the order book, the simulator and the WASM API.
//
// Everything that touches money is an integer. Prices are whole ticks (one
// tick = $0.01) and quantities are whole shares, so matching is exact and a
// run is reproducible bit for bit from its seed.
#pragma once

#include <cstdint>

namespace tf {

using Price = int32_t;     // in ticks
using Qty = int32_t;       // in shares
using OrderId = uint64_t;  // see OrderBook: (sequence << 20) | pool slot
using TraderId = uint16_t;
using Time = int64_t;      // simulated time in microseconds

inline constexpr Time kMillisecond = 1'000;
inline constexpr Time kSecond = 1'000'000;

/// Number of price levels the book can hold. Valid prices are 1 .. kMaxPrice.
/// At one cent per tick this is a band of $0.01 to $655.35.
inline constexpr int kPriceLevels = 1 << 16;
inline constexpr Price kMaxPrice = kPriceLevels - 1;
inline constexpr Price kNoPrice = 0;

enum class Side : uint8_t { Buy = 0, Sell = 1 };

constexpr Side opposite(Side s) { return s == Side::Buy ? Side::Sell : Side::Buy; }
/// +1 for buys, -1 for sells.
constexpr int sign(Side s) { return s == Side::Buy ? 1 : -1; }

enum class OrderType : uint8_t { Limit = 0, Market = 1 };

enum class TimeInForce : uint8_t {
  GTC = 0,  // good till cancelled: rest whatever does not trade
  IOC = 1,  // immediate or cancel: trade what you can, cancel the rest
  FOK = 2,  // fill or kill: trade everything now or nothing at all
};

enum class Status : uint8_t {
  Resting = 0,    // nothing traded, the whole order is on the book
  Partial = 1,    // some traded; the rest is resting (GTC) or cancelled (IOC)
  Filled = 2,     // everything traded
  Cancelled = 3,  // nothing traded and nothing rests (IOC or market, no liquidity)
  Rejected = 4,
};

enum class Reject : uint8_t {
  None = 0,
  BadQuantity = 1,
  BadPrice = 2,
  WouldCross = 3,     // post-only order would have traded
  Unfillable = 4,     // fill-or-kill order could not be filled in full
  BookFull = 5,
  Halted = 6,         // trading halt (set by the market, not the book)
};

struct NewOrder {
  TraderId trader = 0;
  Side side = Side::Buy;
  OrderType type = OrderType::Limit;
  TimeInForce tif = TimeInForce::GTC;
  bool post_only = false;
  Price price = kNoPrice;  // ignored for market orders
  Qty qty = 0;
};

/// One trade between a resting (maker) order and an incoming (taker) order.
/// The trade always happens at the maker's price.
struct Fill {
  OrderId maker_id;
  OrderId taker_id;
  TraderId maker;
  TraderId taker;
  Side taker_side;
  Price price;
  Qty qty;
  Qty maker_remaining;
};

/// A resting order that left the book without trading.
struct Removed {
  OrderId id;
  TraderId trader;
  Side side;
  Price price;
  Qty qty;
};

struct Result {
  OrderId id = 0;
  Status status = Status::Rejected;
  Reject reject = Reject::None;
  Qty filled = 0;
  Qty resting = 0;
  int64_t notional = 0;  // sum of price * qty over this order's fills

  bool ok() const { return status != Status::Rejected; }
};

struct LevelView {
  Price price;
  Qty qty;
  int32_t orders;
};

}  // namespace tf
