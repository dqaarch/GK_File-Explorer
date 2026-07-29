// dummy_main.cpp - Phase 0 smoke test
// Verifies Emscripten toolchain can compile + link + produce a wasm + glue
// module loadable by ThreeDModelViewer in the Tauri WebView2.
//
// This file contains ONE entry point (`abc_hello`) and NO Alembic/Imath deps.
// Phase 1 will introduce `alembic_glue.cpp` with the real C ABI.

#include <cstdio>

extern "C" {
  // Emscripten exports symbols prefixed with `_` in wasm text format, but
  // EXPORTED_FUNCTIONS in linker flags uses the un-prefixed name. The attribute
  // `__attribute__((visibility("default")))` is the correct way to force an
  // export when also building with `-fvisibility=hidden`.
  __attribute__((visibility("default")))
  void abc_hello() {
    std::printf("[abc_wasm] alembic wasm online (smoke test)\n");
    std::fflush(stdout);
  }

  // Returns a constant int so the smoke test can verify pointer marshalling
  // works through Emscripten cwrap.
  __attribute__((visibility("default")))
  int abc_add(int a, int b) {
    return a + b;
  }
}