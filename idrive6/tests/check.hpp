// check.hpp - tiny host-test harness (no framework), C++98.
#ifndef IDRIVE6_CHECK_HPP
#define IDRIVE6_CHECK_HPP
#include <cstdio>
#include <string>

namespace chk {
static int failures = 0;
static int checks = 0;

inline void ok(bool cond, const char* what) {
    ++checks;
    if (!cond) { ++failures; std::printf("  FAIL: %s\n", what); }
}
inline void near(double got, double want, double eps, const char* what) {
    ++checks;
    double d = got - want; if (d < 0) d = -d;
    if (d > eps) { ++failures; std::printf("  FAIL: %s (got %.4f, want %.4f)\n", what, got, want); }
}
inline void eqs(const std::string& got, const std::string& want, const char* what) {
    ++checks;
    if (got != want) { ++failures; std::printf("  FAIL: %s (got \"%s\", want \"%s\")\n", what, got.c_str(), want.c_str()); }
}
inline int report() {
    std::printf("%s: %d checks, %d failed\n", failures ? "FAILED" : "ok", checks, failures);
    return failures ? 1 : 0;
}
}  // namespace chk
#endif
