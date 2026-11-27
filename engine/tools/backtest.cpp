// Backtest the built-in strategies from the command line.
//
//   tf_backtest                               every strategy, 20 seeds, calm market
//   tf_backtest momentum --scenario crash     one strategy through a flash crash
//   tf_backtest meanrev --set window=120 --seeds 50
//   tf_backtest --list                        strategies, parameters and scenarios
//
// Each seed is a different ten-minute session (after five minutes of warm-up).
// Every strategy sees the same seeds, so the comparison is paired.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "tf/backtest.hpp"

using namespace tf;

namespace {

void usage() {
  std::puts(
      "usage: tf_backtest [strategy|all] [--seeds N] [--first-seed S] [--minutes M]\n"
      "                   [--scenario NAME] [--set key=value ...] [--runs] [--list]");
}

void list() {
  std::puts("Strategies (parameters with their defaults and ranges):\n");
  for (int i = 0; i < static_cast<int>(StrategyId::Count); ++i) {
    const StrategyInfo& s = strategy_info(static_cast<StrategyId>(i));
    std::printf("  %-10s %s. %s\n", s.key, s.name, s.style);
    for (int k = 0; k < s.param_count; ++k) {
      const ParamInfo& p = s.params[k];
      std::printf("      %-14s %8g %-3s [%g .. %g]  %s\n", p.key, p.def, p.unit, p.min, p.max, p.help);
    }
    std::puts("");
  }
  std::fputs("Scenarios: ", stdout);
  for (int i = 0; i < static_cast<int>(ScenarioKind::Count); ++i)
    std::printf("%s%s", i ? ", " : "", scenario_key(static_cast<ScenarioKind>(i)));
  std::puts(" (fires halfway through each session)");
}

std::string money(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%s$%.0f", v < 0 ? "-" : "", std::abs(v));
  return buf;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<StrategyId> strategies;
  int seeds = 20;
  uint64_t first_seed = 1000;
  double minutes = 10;
  bool show_runs = false;
  ScenarioKind scenario = ScenarioKind::None;
  std::vector<std::pair<std::string, double>> sets;

  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&](const char* what) -> const char* {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "error: %s needs a value\n", what);
        std::exit(2);
      }
      return argv[++i];
    };
    StrategyId id;
    if (a == "--list") { list(); return 0; }
    else if (a == "-h" || a == "--help") { usage(); return 0; }
    else if (a == "--seeds") seeds = std::max(1, std::atoi(next("--seeds")));
    else if (a == "--first-seed") first_seed = std::strtoull(next("--first-seed"), nullptr, 10);
    else if (a == "--minutes") minutes = std::max(0.1, std::atof(next("--minutes")));
    else if (a == "--runs") show_runs = true;
    else if (a == "--scenario") {
      const std::string key = next("--scenario");
      if (!parse_scenario(key, scenario)) {
        std::fprintf(stderr, "error: unknown scenario '%s' (try --list)\n", key.c_str());
        return 2;
      }
    } else if (a == "--set") {
      const std::string kv = next("--set");
      const size_t eq = kv.find('=');
      if (eq == std::string::npos) {
        std::fprintf(stderr, "error: --set wants key=value, got '%s'\n", kv.c_str());
        return 2;
      }
      sets.emplace_back(kv.substr(0, eq), std::atof(kv.c_str() + eq + 1));
    } else if (a == "all") {
      for (int k = 0; k < static_cast<int>(StrategyId::Count); ++k) strategies.push_back(static_cast<StrategyId>(k));
    } else if (parse_strategy(a, id)) {
      strategies.push_back(id);
    } else {
      std::fprintf(stderr, "error: unknown strategy or option '%s' (try --list)\n", a.c_str());
      return 2;
    }
  }
  if (strategies.empty())
    for (int k = 0; k < static_cast<int>(StrategyId::Count); ++k) strategies.push_back(static_cast<StrategyId>(k));

  std::printf("Tickforge backtest · %d seeds × %g min (seeds %llu to %llu) · scenario: %s\n\n", seeds, minutes,
              static_cast<unsigned long long>(first_seed),
              static_cast<unsigned long long>(first_seed + seeds - 1), scenario_key(scenario));
  std::printf("  %-26s %9s %8s %8s %6s %7s %8s %9s %7s %9s\n", "strategy", "mean P&L", "stdev", "t-stat", "win",
              "Sharpe", "max DD", "volume", "maker", "markout");
  std::printf("  %-26s %9s %8s %8s %6s %7s %8s %9s %7s %9s\n", "", "$", "$", "", "%", "ann.", "$", "sh/run", "%",
              "5s tick");

  const auto t0 = std::chrono::steady_clock::now();
  int total_runs = 0;
  for (StrategyId id : strategies) {
    const StrategyInfo& info = strategy_info(id);
    double params[kMaxStrategyParams];
    for (int k = 0; k < kMaxStrategyParams; ++k) params[k] = info.params[k].def;
    for (const auto& [key, value] : sets) {
      for (int k = 0; k < info.param_count; ++k)
        if (key == info.params[k].key) params[k] = value;
    }
    std::vector<BacktestResult> runs;
    double volume = 0, maker = 0, markout = 0;
    for (int s = 0; s < seeds; ++s) {
      BacktestSpec spec;
      spec.seed = first_seed + static_cast<uint64_t>(s);
      spec.duration = minutes * 60;
      spec.scenario = scenario;
      runs.push_back(run_backtest(id, params, spec));
      const BacktestMetrics& k = runs.back().metrics;
      volume += static_cast<double>(k.volume);
      maker += k.maker_share * static_cast<double>(k.volume);
      markout += k.markout[1];
      ++total_runs;
    }
    const BatchSummary b = summarize(runs);
    std::printf("  %-26s %9.0f %8.0f %8.2f %6.0f %7.1f %8.0f %9.0f %7.0f %9.2f\n", info.name, b.mean, b.stdev,
                b.t_stat, b.win_rate * 100, b.mean_sharpe, b.mean_drawdown, volume / seeds,
                volume > 0 ? maker / volume * 100 : 0, markout / seeds);
    if (show_runs) {
      for (const BacktestResult& r : runs) {
        const BacktestMetrics& k = r.metrics;
        std::printf("      seed %-6llu %8s  = spread %7s + inventory %7s - fees %6s   market %+.2f\n",
                    static_cast<unsigned long long>(r.spec.seed), money(k.pnl).c_str(), money(k.spread).c_str(),
                    money(k.inventory).c_str(), money(k.fees).c_str(), k.market_move);
      }
    }
  }
  const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::printf("\n%d sessions (%.0f simulated hours) in %.2f s.\n", total_runs, total_runs * minutes / 60, secs);
  std::puts("t-stat is mean P&L over its standard error: above about 2, the edge is unlikely to be luck.");
  std::puts("Sharpe is annualised from one-second P&L changes; markout is how far the mid moved in your favour");
  std::puts("5 s after each fill (negative means the people you traded with knew more).");
  return 0;
}
