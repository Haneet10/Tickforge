#include <set>

#include "check.hpp"
#include "tf/price_index.hpp"
#include "tf/rng.hpp"

using namespace tf;

TEST("price index: empty index finds nothing") {
  PriceIndex ix;
  CHECK(ix.empty());
  CHECK_EQ(ix.next(1), kNoPrice);
  CHECK_EQ(ix.prev(kMaxPrice), kNoPrice);
}

TEST("price index: neighbours across word and block boundaries") {
  PriceIndex ix;
  for (Price p : {1, 63, 64, 65, 4095, 4096, 4097, 40000, kMaxPrice}) ix.set(p);
  CHECK_EQ(ix.next(1), 1);
  CHECK_EQ(ix.next(2), 63);
  CHECK_EQ(ix.next(64), 64);
  CHECK_EQ(ix.next(66), 4095);
  CHECK_EQ(ix.next(4098), 40000);
  CHECK_EQ(ix.next(40001), kMaxPrice);
  CHECK_EQ(ix.prev(kMaxPrice), kMaxPrice);
  CHECK_EQ(ix.prev(kMaxPrice - 1), 40000);
  CHECK_EQ(ix.prev(39999), 4097);
  CHECK_EQ(ix.prev(4094), 65);
  CHECK_EQ(ix.prev(62), 1);
  ix.clear(1);
  CHECK_EQ(ix.prev(62), kNoPrice);
  ix.clear(kMaxPrice);
  CHECK_EQ(ix.next(40001), kNoPrice);
}

TEST("price index: agrees with std::set on random workloads") {
  Rng rng(7);
  PriceIndex ix;
  std::set<Price> ref;
  for (int step = 0; step < 200000; ++step) {
    // Mix of dense clusters and far-apart prices.
    const Price p = rng.chance(0.7) ? static_cast<Price>(30000 + rng.below(400))
                                    : static_cast<Price>(1 + rng.below(kMaxPrice));
    if (rng.chance(0.5)) { ix.set(p); ref.insert(p); } else { ix.clear(p); ref.erase(p); }

    const Price q = static_cast<Price>(1 + rng.below(kMaxPrice));
    auto up = ref.lower_bound(q);
    CHECK_EQ(ix.next(q), up == ref.end() ? kNoPrice : *up);
    auto down = ref.upper_bound(q);
    CHECK_EQ(ix.prev(q), down == ref.begin() ? kNoPrice : *std::prev(down));
    if (::check::failures()) return;
  }
  CHECK_EQ(ix.empty(), ref.empty());
}
