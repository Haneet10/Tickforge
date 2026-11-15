// Differential fuzzing: drive the real book and the reference book with the
// same random stream of orders and demand identical behaviour at every step.
#include <unordered_map>
#include <vector>

#include "check.hpp"
#include "reference_book.hpp"
#include "tf/order_book.hpp"
#include "tf/rng.hpp"

using namespace tf;

namespace {

struct Profile {
  const char* name;
  uint64_t seed;
  int steps;
  int price_span;      // prices are drawn from mid +/- span
  double cancel_prob;
  double market_prob;
  int traders;
};

void run(const Profile& pf) {
  Rng rng(pf.seed);
  OrderBook book;
  ref::ReferenceBook slow;
  std::unordered_map<OrderId, int> handle_of;  // real id -> handle
  std::vector<OrderId> ids;                    // handle -> real id (0 if it never rested)
  std::vector<int> live;                       // handles that may still be resting

  const Price mid = 10000;
  for (int step = 0; step < pf.steps; ++step) {
    const double u = rng.uniform();
    if (u < pf.cancel_prob && !live.empty()) {
      const uint32_t k = rng.below(static_cast<uint32_t>(live.size()));
      const int h = live[k];
      live[k] = live.back();
      live.pop_back();
      if (rng.chance(0.2)) {
        const ref::RefOrder* target = nullptr;
        for (const auto& o : slow.orders())
          if (o.handle == h) target = &o;
        const Qty nq = target ? std::max<Qty>(1, target->qty / 2) : 1;
        CHECK_EQ(book.reduce(ids[h], nq), slow.reduce(h, nq));
        live.push_back(h);
      } else {
        CHECK_EQ(book.cancel(ids[h]), slow.cancel(h));
      }
    } else {
      NewOrder o;
      o.trader = static_cast<TraderId>(1 + rng.below(pf.traders));
      o.side = rng.chance(0.5) ? Side::Buy : Side::Sell;
      o.qty = static_cast<Qty>(1 + rng.below(200));
      if (rng.chance(0.01)) o.qty = 0;  // invalid on purpose
      if (rng.chance(pf.market_prob)) {
        o.type = OrderType::Market;
        o.tif = rng.chance(0.2) ? TimeInForce::FOK : TimeInForce::IOC;
      } else {
        o.price = mid - pf.price_span + static_cast<Price>(rng.below(2 * pf.price_span + 1));
        const double t = rng.uniform();
        o.tif = t < 0.75 ? TimeInForce::GTC : (t < 0.9 ? TimeInForce::IOC : TimeInForce::FOK);
        o.post_only = o.tif == TimeInForce::GTC && rng.chance(0.1);
      }
      const int h = static_cast<int>(ids.size());
      const Result r = book.submit(o);
      Status ref_status;
      const Qty ref_resting = slow.submit(h, o, &ref_status);

      CHECK_EQ(r.status, ref_status);
      CHECK_EQ(r.resting, ref_resting);
      CHECK_EQ(book.fills().size(), slow.fills.size());
      int64_t notional = 0;
      for (size_t i = 0; i < book.fills().size() && i < slow.fills.size(); ++i) {
        const Fill& f = book.fills()[i];
        const ref::RefFill expect = slow.fills[i];
        const ref::RefFill got{handle_of[f.maker_id], f.price, f.qty};
        CHECK(got == expect);
        notional += static_cast<int64_t>(f.price) * f.qty;
      }
      CHECK_EQ(r.notional, notional);
      CHECK_EQ(book.stp_cancels().size(), slow.stp_cancelled.size());
      for (size_t i = 0; i < book.stp_cancels().size() && i < slow.stp_cancelled.size(); ++i)
        CHECK_EQ(handle_of[book.stp_cancels()[i].id], slow.stp_cancelled[i]);

      ids.push_back(r.resting > 0 ? r.id : 0);
      if (r.resting > 0) {
        handle_of[r.id] = h;
        live.push_back(h);
      }
    }

    CHECK_EQ(book.best_bid(), slow.best_bid());
    CHECK_EQ(book.best_ask(), slow.best_ask());
    CHECK_EQ(static_cast<size_t>(book.live_orders()), slow.size());
    const Price probe = mid - pf.price_span + static_cast<Price>(rng.below(2 * pf.price_span + 1));
    CHECK_EQ(book.qty_at(probe), slow.qty_at(probe));
    if (step % 5000 == 0) CHECK(book.check_invariants());
    if (::check::failures()) {
      std::printf("    profile '%s' diverged at step %d\n", pf.name, step);
      return;
    }
  }
  CHECK(book.check_invariants());
}

}  // namespace

TEST("fuzz: tight market, heavy cancels") { run({"tight", 11, 120000, 12, 0.45, 0.10, 6}); }
TEST("fuzz: wide sparse book") { run({"sparse", 23, 60000, 3000, 0.30, 0.05, 6}); }
TEST("fuzz: aggressive flow that empties the book") { run({"sweep", 37, 120000, 6, 0.10, 0.45, 4}); }
TEST("fuzz: two traders, constant self-trade prevention") { run({"stp", 41, 80000, 5, 0.25, 0.20, 2}); }
TEST("fuzz: deep resting book") { run({"deep", 59, 40000, 40, 0.05, 0.02, 12}); }
