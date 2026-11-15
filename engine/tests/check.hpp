// A very small test harness: no dependencies, one header.
//
//   TEST("name") { CHECK(x == y); }
//
// Every TEST registers itself; tests/main.cpp runs them all.
#pragma once

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace check {

struct Case {
  const char* name;
  std::function<void()> fn;
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

inline int& failures() {
  static int n = 0;
  return n;
}

inline int& checks() {
  static int n = 0;
  return n;
}

struct Registrar {
  Registrar(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

inline void report(bool ok, const char* expr, const char* file, int line) {
  ++checks();
  if (ok) return;
  ++failures();
  std::printf("    FAILED  %s:%d  %s\n", file, line, expr);
}

inline int run_all(const char* filter) {
  int ran = 0, failed_cases = 0;
  for (const Case& c : registry()) {
    if (filter && std::string(c.name).find(filter) == std::string::npos) continue;
    const int before = failures();
    c.fn();
    ++ran;
    const bool ok = failures() == before;
    if (!ok) ++failed_cases;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", c.name);
  }
  std::printf("\n%d tests, %d checks, %d failed\n", ran, checks(), failed_cases);
  return failed_cases == 0 ? 0 : 1;
}

}  // namespace check

#define TF_CONCAT2(a, b) a##b
#define TF_CONCAT(a, b) TF_CONCAT2(a, b)
#define TEST(name)                                                        \
  static void TF_CONCAT(tf_test_, __LINE__)();                            \
  static ::check::Registrar TF_CONCAT(tf_reg_, __LINE__)(name, TF_CONCAT(tf_test_, __LINE__)); \
  static void TF_CONCAT(tf_test_, __LINE__)()
#define CHECK(expr) ::check::report(static_cast<bool>(expr), #expr, __FILE__, __LINE__)
#define CHECK_EQ(a, b) ::check::report((a) == (b), #a " == " #b, __FILE__, __LINE__)
#define CHECK_NEAR(a, b, tol) \
  ::check::report(((a) - (b) < (tol)) && ((b) - (a) < (tol)), #a " ~= " #b, __FILE__, __LINE__)
