// Deterministic random numbers.
//
// xoshiro256** seeded through splitmix64. Every agent owns its own stream,
// derived from the market seed and the agent's index, so a run is a pure
// function of its seed and the user's actions.
#pragma once

#include <cmath>
#include <cstdint>

namespace tf {

class Rng {
 public:
  explicit Rng(uint64_t seed = 1) { reseed(seed); }

  void reseed(uint64_t seed) {
    for (auto& s : s_) s = splitmix(seed);
    has_spare_ = false;
  }

  /// A fresh, statistically independent stream for the given index.
  static Rng stream(uint64_t seed, uint64_t index) {
    uint64_t x = seed ^ (0x9E3779B97F4A7C15ULL * (index + 1));
    return Rng(splitmix(x));
  }

  uint64_t next() {
    const uint64_t result = rotl(s_[1] * 5, 7) * 9;
    const uint64_t t = s_[1] << 17;
    s_[2] ^= s_[0];
    s_[3] ^= s_[1];
    s_[1] ^= s_[2];
    s_[0] ^= s_[3];
    s_[2] ^= t;
    s_[3] = rotl(s_[3], 45);
    return result;
  }

  /// Uniform in [0, 1).
  double uniform() { return static_cast<double>(next() >> 11) * 0x1.0p-53; }
  double uniform(double lo, double hi) { return lo + (hi - lo) * uniform(); }
  /// Uniform integer in [0, n). n must be > 0.
  uint32_t below(uint32_t n) {
    return static_cast<uint32_t>(((next() >> 32) * static_cast<uint64_t>(n)) >> 32);
  }
  bool chance(double p) { return uniform() < p; }

  /// Standard normal (Marsaglia polar method).
  double normal() {
    if (has_spare_) {
      has_spare_ = false;
      return spare_;
    }
    double u, v, s;
    do {
      u = uniform(-1.0, 1.0);
      v = uniform(-1.0, 1.0);
      s = u * u + v * v;
    } while (s >= 1.0 || s == 0.0);
    const double m = std::sqrt(-2.0 * std::log(s) / s);
    spare_ = v * m;
    has_spare_ = true;
    return u * m;
  }
  double normal(double mean, double sd) { return mean + sd * normal(); }

  /// Exponential waiting time with the given rate (events per unit time).
  double exponential(double rate) { return -std::log(1.0 - uniform()) / rate; }

  /// Geometric on {0, 1, 2, ...} with success probability p.
  int geometric(double p) {
    return static_cast<int>(std::floor(std::log(1.0 - uniform()) / std::log(1.0 - p)));
  }

  /// Discrete power law on {0, 1, 2, ...}: P(k) ~ (1 + k)^-alpha, truncated at max.
  int power_law(double alpha, int max) {
    // Inverse transform on the continuous Pareto, then floor.
    const double u = uniform();
    const double x = std::pow(1.0 - u, -1.0 / (alpha - 1.0)) - 1.0;
    return x >= max ? max : static_cast<int>(x);
  }

 private:
  static uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
  static uint64_t splitmix(uint64_t& x) {
    uint64_t z = (x += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
  }

  uint64_t s_[4];
  double spare_ = 0.0;
  bool has_spare_ = false;
};

}  // namespace tf
