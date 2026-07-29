// wabc_smoke.cpp - Phase 2 smoke test
// Verifies the wabc C ABI wrapper + Emscripten toolchain work correctly
// with the new entry points (wabc_open_buffer, etc.)

#include <cstdio>
#include <cstdint>

// Entry points exposed to JS via EMSCRIPTEN_KEEPALIVE
// The symbol name WITHOUT underscore is what JS uses via cwrap

extern "C" {

  // Simple arithmetic test — verifies basic FFI works
  __attribute__((visibility("default")))
  int wabc_smoke_add(int a, int b) {
    std::printf("[wabc_smoke] wabc_smoke_add(%d, %d)\n", a, b);
    std::fflush(stdout);
    return a + b;
  }

  // Returns a constant string to verify string passing works
  __attribute__((visibility("default")))
  const char* wabc_smoke_version() {
    return "wabc_v0.1.0_smoke";
  }

  // Echo an integer to verify memory read works
  __attribute__((visibility("default")))
  int32_t wabc_smoke_echo_int(int32_t val) {
    return val;
  }
}
