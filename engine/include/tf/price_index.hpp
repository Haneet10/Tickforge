// A three-level bitmap over the price grid.
//
// The book needs to answer "what is the next non-empty price level above (or
// below) this one?" every time a level empties. A tree-based book answers in
// O(log n) with a pointer chase per step. Here one bit per price says whether
// the level is occupied, a second layer has one bit per 64-bit word of the
// first, and a third has one bit per word of the second. A query is at most
// three count-trailing-zeros instructions and touches three cache lines, no
// matter how far away the next level is.
#pragma once

#include <array>
#include <cstdint>

#include "tf/types.hpp"

namespace tf {

class PriceIndex {
 public:
  void set(Price p) {
    const uint32_t i = static_cast<uint32_t>(p);
    l0_[i >> 6] |= bit(i);
    l1_[i >> 12] |= bit(i >> 6);
    l2_ |= bit(i >> 12);
  }

  void clear(Price p) {
    const uint32_t i = static_cast<uint32_t>(p);
    l0_[i >> 6] &= ~bit(i);
    if (l0_[i >> 6] != 0) return;
    l1_[i >> 12] &= ~bit(i >> 6);
    if (l1_[i >> 12] != 0) return;
    l2_ &= ~bit(i >> 12);
  }

  bool test(Price p) const {
    const uint32_t i = static_cast<uint32_t>(p);
    return (l0_[i >> 6] & bit(i)) != 0;
  }

  bool empty() const { return l2_ == 0; }

  /// Lowest occupied price >= p, or kNoPrice if there is none.
  Price next(Price p) const {
    if (p > kMaxPrice) return kNoPrice;
    if (p < 0) p = 0;
    uint32_t i = static_cast<uint32_t>(p);
    uint32_t w = i >> 6;
    uint64_t bits = l0_[w] & (~0ULL << (i & 63));
    if (bits) return static_cast<Price>((w << 6) + ctz(bits));

    const uint32_t i1 = w + 1;  // first L0 word strictly after w
    if (i1 >= kL0Words) return kNoPrice;
    uint32_t w1 = i1 >> 6;
    bits = l1_[w1] & (~0ULL << (i1 & 63));
    if (!bits) {
      const uint32_t i2 = w1 + 1;
      if (i2 >= kL1Words) return kNoPrice;
      const uint64_t top = l2_ & (~0ULL << i2);
      if (!top) return kNoPrice;
      w1 = ctz(top);
      bits = l1_[w1];
    }
    w = (w1 << 6) + ctz(bits);
    return static_cast<Price>((w << 6) + ctz(l0_[w]));
  }

  /// Highest occupied price <= p, or kNoPrice if there is none.
  Price prev(Price p) const {
    if (p <= 0) return kNoPrice;
    if (p > kMaxPrice) p = kMaxPrice;
    uint32_t i = static_cast<uint32_t>(p);
    uint32_t w = i >> 6;
    uint64_t bits = l0_[w] & (~0ULL >> (63 - (i & 63)));
    if (bits) return static_cast<Price>((w << 6) + msb(bits));

    if (w == 0) return kNoPrice;
    const uint32_t i1 = w - 1;  // last L0 word strictly before w
    uint32_t w1 = i1 >> 6;
    bits = l1_[w1] & (~0ULL >> (63 - (i1 & 63)));
    if (!bits) {
      if (w1 == 0) return kNoPrice;
      const uint32_t i2 = w1 - 1;
      const uint64_t top = l2_ & (~0ULL >> (63 - i2));
      if (!top) return kNoPrice;
      w1 = msb(top);
      bits = l1_[w1];
    }
    w = (w1 << 6) + msb(bits);
    return static_cast<Price>((w << 6) + msb(l0_[w]));
  }

 private:
  static constexpr uint32_t kL0Words = kPriceLevels / 64;  // 1024
  static constexpr uint32_t kL1Words = kL0Words / 64;      // 16
  static_assert(kL1Words <= 64, "three levels cover at most 64^3 prices");

  static constexpr uint64_t bit(uint32_t i) { return 1ULL << (i & 63); }
  static uint32_t ctz(uint64_t x) { return static_cast<uint32_t>(__builtin_ctzll(x)); }
  static uint32_t msb(uint64_t x) { return 63u - static_cast<uint32_t>(__builtin_clzll(x)); }

  std::array<uint64_t, kL0Words> l0_{};
  std::array<uint64_t, kL1Words> l1_{};
  uint64_t l2_ = 0;
};

}  // namespace tf
