#include "check.hpp"
#include "tf/order_book.hpp"

using namespace tf;

namespace {

NewOrder limit(TraderId t, Side s, Price p, Qty q, TimeInForce tif = TimeInForce::GTC,
               bool post_only = false) {
  return {t, s, OrderType::Limit, tif, post_only, p, q};
}
NewOrder market(TraderId t, Side s, Qty q) {
  return {t, s, OrderType::Market, TimeInForce::IOC, false, kNoPrice, q};
}

}  // namespace

TEST("book: a new book is empty") {
  OrderBook b;
  CHECK(!b.has_bid());
  CHECK(!b.has_ask());
  CHECK_EQ(b.live_orders(), 0u);
  CHECK(b.check_invariants());
}

TEST("book: limit orders rest and set the best prices") {
  OrderBook b;
  CHECK_EQ(b.submit(limit(1, Side::Buy, 9990, 100)).status, Status::Resting);
  CHECK_EQ(b.submit(limit(1, Side::Buy, 9995, 50)).status, Status::Resting);
  CHECK_EQ(b.submit(limit(2, Side::Sell, 10005, 70)).status, Status::Resting);
  CHECK_EQ(b.submit(limit(2, Side::Sell, 10010, 30)).status, Status::Resting);
  CHECK_EQ(b.best_bid(), 9995);
  CHECK_EQ(b.best_ask(), 10005);
  CHECK_EQ(b.qty_at(9990), 100);
  CHECK_EQ(b.live_orders(), 4u);
  CHECK(b.check_invariants());
}

TEST("book: trades happen at the resting order's price") {
  OrderBook b;
  b.submit(limit(1, Side::Sell, 10000, 100));
  // The buyer is willing to pay 10010 but gets the better resting price.
  const Result r = b.submit(limit(2, Side::Buy, 10010, 60));
  CHECK_EQ(r.status, Status::Filled);
  CHECK_EQ(r.filled, 60);
  CHECK_EQ(r.notional, 60 * 10000LL);
  CHECK_EQ(b.fills().size(), 1u);
  CHECK_EQ(b.fills()[0].price, 10000);
  CHECK_EQ(b.fills()[0].maker, 1);
  CHECK_EQ(b.fills()[0].taker, 2);
  CHECK_EQ(b.fills()[0].maker_remaining, 40);
  CHECK_EQ(b.qty_at(10000), 40);
  CHECK(b.check_invariants());
}

TEST("book: price priority, then time priority") {
  OrderBook b;
  const OrderId late_best = b.submit(limit(1, Side::Sell, 10001, 10)).id;
  const OrderId first = b.submit(limit(2, Side::Sell, 10002, 10)).id;
  const OrderId second = b.submit(limit(3, Side::Sell, 10002, 10)).id;
  const OrderId best = b.submit(limit(4, Side::Sell, 10000, 10)).id;
  b.submit(market(9, Side::Buy, 35));
  const auto& f = b.fills();
  CHECK_EQ(f.size(), 4u);
  CHECK_EQ(f[0].maker_id, best);       // best price first, even though it arrived last
  CHECK_EQ(f[1].maker_id, late_best);
  CHECK_EQ(f[2].maker_id, first);      // same price: earlier order first
  CHECK_EQ(f[3].maker_id, second);
  CHECK_EQ(f[3].qty, 5);
  CHECK_EQ(b.qty_at(10002), 5);
  CHECK(b.check_invariants());
}

TEST("book: a partially filled limit order rests its remainder") {
  OrderBook b;
  b.submit(limit(1, Side::Sell, 10000, 40));
  const Result r = b.submit(limit(2, Side::Buy, 10000, 100));
  CHECK_EQ(r.status, Status::Partial);
  CHECK_EQ(r.filled, 40);
  CHECK_EQ(r.resting, 60);
  CHECK_EQ(b.best_bid(), 10000);
  CHECK(!b.has_ask());
  // The fill refers to the id the order ended up resting under.
  CHECK_EQ(b.fills()[0].taker_id, r.id);
  CHECK(b.find(r.id) != nullptr);
  CHECK(b.check_invariants());
}

TEST("book: market orders sweep levels and never rest") {
  OrderBook b;
  b.submit(limit(1, Side::Buy, 9999, 10));
  b.submit(limit(1, Side::Buy, 9998, 10));
  const Result r = b.submit(market(2, Side::Sell, 50));
  CHECK_EQ(r.status, Status::Partial);
  CHECK_EQ(r.filled, 20);
  CHECK_EQ(r.resting, 0);
  CHECK_EQ(r.notional, 10 * 9999LL + 10 * 9998LL);
  CHECK_EQ(b.live_orders(), 0u);
  CHECK_EQ(b.submit(market(2, Side::Sell, 5)).status, Status::Cancelled);
  CHECK(b.check_invariants());
}

TEST("book: immediate-or-cancel trades what it can and drops the rest") {
  OrderBook b;
  b.submit(limit(1, Side::Sell, 10000, 30));
  b.submit(limit(1, Side::Sell, 10005, 30));
  const Result r = b.submit(limit(2, Side::Buy, 10002, 100, TimeInForce::IOC));
  CHECK_EQ(r.status, Status::Partial);
  CHECK_EQ(r.filled, 30);
  CHECK_EQ(r.resting, 0);
  CHECK(!b.has_bid());
  CHECK_EQ(b.best_ask(), 10005);
}

TEST("book: fill-or-kill is all or nothing") {
  OrderBook b;
  b.submit(limit(1, Side::Sell, 10000, 30));
  b.submit(limit(1, Side::Sell, 10001, 30));
  Result r = b.submit(limit(2, Side::Buy, 10001, 61, TimeInForce::FOK));
  CHECK_EQ(r.status, Status::Rejected);
  CHECK_EQ(r.reject, Reject::Unfillable);
  CHECK_EQ(b.qty_at(10000), 30);  // untouched
  r = b.submit(limit(2, Side::Buy, 10001, 60, TimeInForce::FOK));
  CHECK_EQ(r.status, Status::Filled);
  CHECK(!b.has_ask());
}

TEST("book: post-only orders refuse to take liquidity") {
  OrderBook b;
  b.submit(limit(1, Side::Sell, 10000, 30));
  Result r = b.submit(limit(2, Side::Buy, 10000, 10, TimeInForce::GTC, true));
  CHECK_EQ(r.reject, Reject::WouldCross);
  r = b.submit(limit(2, Side::Buy, 9999, 10, TimeInForce::GTC, true));
  CHECK_EQ(r.status, Status::Resting);
  CHECK_EQ(b.best_bid(), 9999);
}

TEST("book: cancel removes the order and repairs the best price") {
  OrderBook b;
  const OrderId a = b.submit(limit(1, Side::Buy, 9990, 10)).id;
  const OrderId c = b.submit(limit(1, Side::Buy, 9995, 10)).id;
  Removed gone{};
  CHECK(b.cancel(c, &gone));
  CHECK_EQ(gone.price, 9995);
  CHECK_EQ(gone.qty, 10);
  CHECK_EQ(b.best_bid(), 9990);
  CHECK(!b.cancel(c));  // already gone
  CHECK(b.cancel(a));
  CHECK(!b.has_bid());
  CHECK(!b.cancel(123456789));  // never existed
  CHECK(b.check_invariants());
}

TEST("book: a stale id never cancels the order that reused its slot") {
  OrderBook b;
  const OrderId old_id = b.submit(limit(1, Side::Buy, 9990, 10)).id;
  CHECK(b.cancel(old_id));
  const OrderId new_id = b.submit(limit(1, Side::Buy, 9991, 10)).id;
  // Same pool slot, different sequence number.
  CHECK_EQ(old_id & OrderBook::kSlotMask, new_id & OrderBook::kSlotMask);
  CHECK(old_id != new_id);
  CHECK(!b.cancel(old_id));
  CHECK(b.find(new_id) != nullptr);
  CHECK_EQ(b.live_orders(), 1u);
}

TEST("book: reduce keeps queue position") {
  OrderBook b;
  const OrderId first = b.submit(limit(1, Side::Sell, 10000, 50)).id;
  b.submit(limit(2, Side::Sell, 10000, 50));
  CHECK(b.reduce(first, 20));
  CHECK_EQ(b.qty_at(10000), 70);
  CHECK(!b.reduce(first, 20));  // not a reduction
  CHECK(!b.reduce(first, 0));
  b.submit(market(3, Side::Buy, 10));
  CHECK_EQ(b.fills()[0].maker_id, first);  // still at the front
  CHECK(b.check_invariants());
}

TEST("book: self-trade prevention cancels the resting order") {
  OrderBook b;
  const OrderId own = b.submit(limit(1, Side::Sell, 10000, 30)).id;
  b.submit(limit(2, Side::Sell, 10000, 30));
  const Result r = b.submit(limit(1, Side::Buy, 10000, 20));
  CHECK_EQ(r.filled, 20);
  CHECK_EQ(b.fills().size(), 1u);
  CHECK_EQ(b.fills()[0].maker, 2);  // traded with the other participant only
  CHECK_EQ(b.stp_cancels().size(), 1u);
  CHECK_EQ(b.stp_cancels()[0].id, own);
  CHECK(b.find(own) == nullptr);
  CHECK(b.check_invariants());
}

TEST("book: rejects bad input") {
  OrderBook b;
  CHECK_EQ(b.submit(limit(1, Side::Buy, 100, 0)).reject, Reject::BadQuantity);
  CHECK_EQ(b.submit(limit(1, Side::Buy, 100, -5)).reject, Reject::BadQuantity);
  CHECK_EQ(b.submit(limit(1, Side::Buy, 0, 5)).reject, Reject::BadPrice);
  CHECK_EQ(b.submit(limit(1, Side::Buy, kMaxPrice + 1, 5)).reject, Reject::BadPrice);
  CHECK_EQ(b.live_orders(), 0u);
}

TEST("book: depth lists levels best first") {
  OrderBook b;
  for (Price p : {9990, 9995, 9993}) b.submit(limit(1, Side::Buy, p, 10));
  b.submit(limit(1, Side::Buy, 9995, 5));
  for (Price p : {10010, 10003}) b.submit(limit(2, Side::Sell, p, 7));
  LevelView v[8];
  CHECK_EQ(b.depth(Side::Buy, v, 8), 3);
  CHECK_EQ(v[0].price, 9995);
  CHECK_EQ(v[0].qty, 15);
  CHECK_EQ(v[0].orders, 2);
  CHECK_EQ(v[1].price, 9993);
  CHECK_EQ(v[2].price, 9990);
  CHECK_EQ(b.depth(Side::Sell, v, 1), 1);
  CHECK_EQ(v[0].price, 10003);
}

TEST("book: works at the edges of the price grid") {
  OrderBook b;
  b.submit(limit(1, Side::Buy, 1, 10));
  b.submit(limit(2, Side::Sell, kMaxPrice, 10));
  CHECK_EQ(b.best_bid(), 1);
  CHECK_EQ(b.best_ask(), kMaxPrice);
  CHECK_EQ(b.submit(market(3, Side::Buy, 10)).notional, 10LL * kMaxPrice);
  CHECK_EQ(b.submit(market(3, Side::Sell, 10)).notional, 10LL);
  CHECK(b.check_invariants());
}
