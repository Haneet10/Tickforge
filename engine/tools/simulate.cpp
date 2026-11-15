// Run the market headless and print what it looks like.
//
//   tf_simulate [seconds] [seed] [scenario] [--bot gamma]
//
// Scenarios: none, crash, news, drought, whale, fatfinger. The scenario fires
// at the midpoint of the run and the price path around it is printed.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "tf/market.hpp"

using namespace tf;

static const char* kKindNames[] = {"user", "retail", "market maker", "momentum",
                                   "value", "informed", "institution"};

int main(int argc, char** argv) {
  const int seconds = argc > 1 ? std::atoi(argv[1]) : 1800;
  Config cfg;
  cfg.seed = argc > 2 ? std::strtoull(argv[2], nullptr, 10) : 1;
  const std::string scenario = argc > 3 ? argv[3] : "none";
  double bot_gamma = 0;
  bool breaker = false;
  for (int i = 4; i < argc; ++i) {
    if (!std::strcmp(argv[i], "--bot") && i + 1 < argc) bot_gamma = std::atof(argv[++i]);
    if (!std::strcmp(argv[i], "--breaker")) breaker = true;
  }
  cfg.breaker_enabled = breaker;

  Market m(cfg);
  if (bot_gamma > 0) {
    BotParams bp;
    bp.gamma = bot_gamma;
    m.set_bot(true, bp);
  }

  const auto t0 = std::chrono::steady_clock::now();
  double spread_sum = 0, depth_sum = 0, gap_sum = 0;
  int spread_n = 0, empty_side = 0;
  const int fire_at = seconds / 2;
  for (int s = 0; s < seconds; ++s) {
    if (s == fire_at) {
      if (scenario == "crash") m.flash_crash(1.0);
      else if (scenario == "news") m.news(-0.02);
      else if (scenario == "drought") m.liquidity_drought(60);
      else if (scenario == "whale") m.whale(Side::Buy, 20000, 60);
      else if (scenario == "fatfinger") m.fat_finger(Side::Sell, 8000);
    }
    for (int k = 0; k < 10; ++k) {
      m.step(100 * kMillisecond);
      const OrderBook& b = m.book();
      if (b.has_bid() && b.has_ask()) {
        spread_sum += b.best_ask() - b.best_bid();
        LevelView lv[5];
        int n = b.depth(Side::Buy, lv, 5);
        for (int i = 0; i < n; ++i) depth_sum += lv[i].qty;
        n = b.depth(Side::Sell, lv, 5);
        for (int i = 0; i < n; ++i) depth_sum += lv[i].qty;
        ++spread_n;
      } else {
        ++empty_side;
      }
      gap_sum += std::abs(m.mid() - m.fundamental());
    }
    if (scenario != "none" && s >= fire_at - 5 && s < fire_at + 240 && (s - fire_at) % 5 == 0) {
      std::printf("  t%+4ds  last %8.2f  mid %8.2f  value %8.2f  spread %3d  sigma %5.1f  %s\n",
                  s - fire_at, m.last() / 100.0, m.mid() / 100.0, m.fundamental() / 100.0,
                  m.book().has_bid() && m.book().has_ask() ? m.book().best_ask() - m.book().best_bid() : -1,
                  m.sigma(), m.halted() ? "HALTED" : "");
    }
  }
  const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

  // Return statistics from one-second closes.
  const int64_t n = m.bar_count();
  const Bar* bars = m.bars(0);
  std::vector<double> r;
  for (int64_t i = 1; i < n; ++i) r.push_back(bars[i].close - bars[i - 1].close);
  double mean = 0, var = 0, m4 = 0, ac1 = 0, acabs = 0, absmean = 0;
  for (double x : r) mean += x;
  mean /= r.size();
  for (double x : r) { var += (x - mean) * (x - mean); m4 += std::pow(x - mean, 4); absmean += std::abs(x); }
  var /= r.size(); m4 /= r.size(); absmean /= r.size();
  for (size_t i = 1; i < r.size(); ++i) {
    ac1 += (r[i] - mean) * (r[i - 1] - mean);
    acabs += (std::abs(r[i]) - absmean) * (std::abs(r[i - 1]) - absmean);
  }
  double absvar = 0;
  for (double x : r) absvar += (std::abs(x) - absmean) * (std::abs(x) - absmean);

  std::printf("\n%d s simulated in %.2f s wall (%.0fx real time), seed %llu\n", seconds, wall,
              seconds / wall, static_cast<unsigned long long>(cfg.seed));
  std::printf("messages %llu (%.0f/s sim, %.2f M/s wall)   trades %lld (%.1f/s)   volume %lld (%.0f sh/s)\n",
              static_cast<unsigned long long>(m.messages()), m.messages() / double(seconds),
              m.messages() / wall / 1e6, static_cast<long long>(m.total_trades()),
              m.total_trades() / double(seconds), static_cast<long long>(m.total_volume()),
              m.total_volume() / double(seconds));
  std::printf("price: last %.2f  low %.2f  high %.2f  value %.2f   live orders %u\n", m.last() / 100.0,
              m.session_low() / 100.0, m.session_high() / 100.0, m.fundamental() / 100.0,
              m.book().live_orders());
  std::printf("avg spread %.2f ticks   avg depth (5 levels, both sides) %.0f sh   one-sided %.2f%%   avg |mid-value| %.1f ticks\n",
              spread_sum / spread_n, depth_sum / spread_n, 100.0 * empty_side / (seconds * 10.0),
              gap_sum / (seconds * 10.0));
  std::printf("1s returns: stdev %.2f ticks  kurtosis %.1f  autocorr %.3f  |r| autocorr %.3f\n",
              std::sqrt(var), m4 / (var * var), ac1 / (var * r.size()), acabs / absvar);

  std::printf("\n%-14s %4s %10s %12s %10s %7s\n", "kind", "n", "position", "pnl ($)", "volume", "maker%");
  for (int k = 0; k < static_cast<int>(Kind::Count); ++k) {
    const auto ks = m.kind_stats(static_cast<Kind>(k));
    std::printf("%-14s %4d %10lld %12.2f %10lld %6.1f%%\n", kKindNames[k], ks.traders,
                static_cast<long long>(ks.position), ks.pnl / 100.0, static_cast<long long>(ks.volume),
                ks.volume ? 100.0 * ks.maker_volume / ks.volume : 0.0);
  }
  if (bot_gamma > 0) {
    const PnlBreakdown& pb = m.user_pnl();
    std::printf("\nbot: total $%.2f = spread $%.2f + inventory $%.2f - fees $%.2f   max dd $%.2f  inv [%lld, %lld]\n",
                pb.total / 100, pb.spread / 100, pb.inventory / 100, pb.fees / 100, pb.max_drawdown / 100,
                static_cast<long long>(pb.max_short), static_cast<long long>(pb.max_long));
    std::printf("     markouts (ticks/share): 1s %.2f  5s %.2f  30s %.2f   two-sided %.0f%%\n",
                pb.markout_qty[0] ? pb.markout_sum[0] / pb.markout_qty[0] : 0,
                pb.markout_qty[1] ? pb.markout_sum[1] / pb.markout_qty[1] : 0,
                pb.markout_qty[2] ? pb.markout_sum[2] / pb.markout_qty[2] : 0,
                100 * pb.two_sided_seconds / std::max(1.0, pb.observed_seconds));
  }
  return 0;
}
