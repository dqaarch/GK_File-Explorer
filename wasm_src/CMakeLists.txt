# CMakeLists.txt - wasm_src top-level
#
# Phase 0: builds a tiny smoke-test wasm (dummy_main.cpp) to verify the
#          Emscripten toolchain is wired up correctly on this machine.
#
# Phase 1: builds the real Alembic loader wasm by compiling all Alembic +
#          Imath C++ sources directly together with alembic_glue.cpp into
#          a single wasm module.
#
# Phase 3: wabc full wasm — wabc_js_binding.cpp + SceneABC.cpp + SceneGraph.cpp
# Full Alembic support via i-saint's SceneABC architecture.
set(ABC_PHASE 0 CACHE STRING "0 = smoke, 1 = alembic, 2 = wabc_smoke, 3 = wabc_full")

cmake_minimum_required(VERSION 3.20)
project(abc_wasm LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Phase selection.
#   0 = smoke test (dummy_main.cpp)
#   1 = real Alembic loader (alembic_glue.cpp)
#   2 = wabc smoke test (wabc_smoke.cpp) — verifies new C ABI before SceneABC integration
#   3 = wabc full wasm (wabc_js_binding.cpp) — full SceneABC + Alembic support
set(ABC_PHASE 0 CACHE STRING "0 = smoke, 1 = alembic, 2 = wabc_smoke, 3 = wabc_full")

# ----------------------------------------------------------------------------
# Find the em++ compiler. When invoked under `emcmake cmake ...` the
# CMAKE_CXX_COMPILER is set to em++.
# ----------------------------------------------------------------------------
find_program(EMSCRIPTEN_EMXX NAMES em++ em++.exe
  HINTS "${CMAKE_CXX_COMPILER}" ENV EMSDK
  DOC "Emscripten em++ compiler"
)
if(NOT EMSCRIPTEN_EMXX)
  message(FATAL_ERROR "em++ not found. Run 'emsdk_env.ps1' or invoke via 'emcmake cmake'.")
endif()
message(STATUS "Using em++: ${EMSCRIPTEN_EMXX}")

set(ABC_OUT_DIR "${CMAKE_BINARY_DIR}")

# ----------------------------------------------------------------------------
# Common link flags. Emscripten expects `-s` and its value as separate tokens.
# Phase 0/2 (no exceptions): basic runtime methods only.
# Phase 1 (with exceptions): full runtime methods for C++ exception propagation.
# ----------------------------------------------------------------------------
set(ABC_LINK_FLAGS_BASE
  -O3
  -s MODULARIZE=1
  -s EXPORT_NAME=WabcModule
  -s ALLOW_MEMORY_GROWTH=1
  -s ERROR_ON_UNDEFINED_SYMBOLS=0
  # Required so Emscripten's MEMFS API (FS.writeFile / FS.unlink) is generated
  # and accessible via Module.FS. Without this, wabc cannot load archives via
  # in-memory files (see docs/PLAN_WABC_INTEGRATION.md — TextDecoder/resizable
  # buffer crash with __syscall_openat when ALLOW_MEMORY_GROWTH=1).
  -s FORCE_FILESYSTEM=1
)
# NOTE: Do NOT use semicolons for array values in -s EXPORTED_RUNTIME_METHODS.
# CMake's batch-file generation mangles them into backslash-escaped quotes.
# Use space-separated quoted values instead.
set(ABC_LINK_FLAGS_NO_EXCEPTIONS
  -s EXPORTED_RUNTIME_METHODS=["cwrap","stackAlloc","stackSave","stackRestore"]
)
set(ABC_LINK_FLAGS_WITH_EXCEPTIONS
  -s EXPORTED_RUNTIME_METHODS=["cwrap","stackAlloc","stackSave","stackRestore","getExceptionMessage","decrementExceptionRefcount"]
)

# Common include dirs (used by all sources).
# ImathInstallPath places ImathConfig.h; ImathSrcPath hosts the per-class
# headers and the src/*.cpp files that include their siblings via "".
# Both must come before Imath/include so a stale header doesn't shadow these.
set(ABC_INCLUDE_DIRS
  "-I${CMAKE_SOURCE_DIR}/Imath/src/Imath"
  "-I${CMAKE_SOURCE_DIR}/Imath/include/Imath"
  "-I${CMAKE_SOURCE_DIR}/Imath/include"
  "-I${CMAKE_SOURCE_DIR}/Imath/config"
  "-I${CMAKE_SOURCE_DIR}/alembic/lib"
  # Imath's public headers use paths like `Imath/half.h`. The standard
  # install layout is `include/Imath/*.h`, so `Imath/include` is the right
  # search root for `Imath/half.h` style includes.
  "-I${CMAKE_SOURCE_DIR}/Imath/include"
)

# ----------------------------------------------------------------------------
# Phase 0: smoke test wasm. No external deps.
# ----------------------------------------------------------------------------
if(ABC_PHASE STREQUAL "0")
  set(ABC_EXPORTED_FUNCTIONS "[_abc_hello,_abc_add]")
  set(ABC_OBJ          "${ABC_OUT_DIR}/dummy_main.cpp.o")
  set(ABC_JS_OUTPUT    "${ABC_OUT_DIR}/alembic.js")
  set(ABC_WASM_OUTPUT  "${ABC_OUT_DIR}/alembic.wasm")

  add_custom_command(
    OUTPUT  "${ABC_OBJ}"
    COMMAND "${EMSCRIPTEN_EMXX}"
            -c -fvisibility=hidden -fno-exceptions -fno-rtti
            "${CMAKE_SOURCE_DIR}/src/dummy_main.cpp"
            -o "${ABC_OBJ}"
    DEPENDS "${CMAKE_SOURCE_DIR}/src/dummy_main.cpp"
    COMMENT "Compiling dummy_main.cpp (Phase 0)"
    VERBATIM
  )

  add_custom_command(
    OUTPUT  "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}"
    COMMAND "${EMSCRIPTEN_EMXX}"
            ${ABC_LINK_FLAGS_BASE}
            ${ABC_LINK_FLAGS_NO_EXCEPTIONS}
            -s EXPORTED_FUNCTIONS=${ABC_EXPORTED_FUNCTIONS}
            "${ABC_OBJ}"
            -o "${ABC_JS_OUTPUT}"
    DEPENDS "${ABC_OBJ}"
    COMMENT "Linking alembic.js + alembic.wasm (Phase 0)"
    VERBATIM
  )

  add_custom_target(abc_wasm_smoke ALL DEPENDS "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}")

# ----------------------------------------------------------------------------
# Phase 1: real Alembic loader wasm.
# ----------------------------------------------------------------------------
elseif(ABC_PHASE STREQUAL "1")
  set(ABC_EXPORTED_FUNCTIONS "[_abc_open_buffer,_abc_close,_abc_list_objects,_abc_get_metadata,_abc_sample_mesh,_abc_get_camera_transforms,_malloc,_free]")
  set(ABC_JS_OUTPUT    "${ABC_OUT_DIR}/alembic.js")
  set(ABC_WASM_OUTPUT  "${ABC_OUT_DIR}/alembic.wasm")

  # Verify Alembic + Imath sources are present.
  if(NOT EXISTS "${CMAKE_SOURCE_DIR}/alembic/CMakeLists.txt")
    message(FATAL_ERROR "Alembic source not found at ${CMAKE_SOURCE_DIR}/alembic. Run build.ps1 -InstallDeps -Phase 1.")
  endif()
  if(NOT EXISTS "${CMAKE_SOURCE_DIR}/Imath/src/Imath/half.h")
    message(FATAL_ERROR "Imath source not found at ${CMAKE_SOURCE_DIR}/Imath. Run build.ps1 -InstallDeps -Phase 1.")
  endif()

  # List of all Alembic + Imath source files (no Tests, no examples).
  set(ABC_ALL_SOURCES
    # Imath
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/half.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathColorAlgo.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathFun.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathMatrixAlgo.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathRandom.cpp"

    # Alembic Util
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/TokenMap.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/Naming.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/SpookyV2.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/Murmur3.cpp"

    # Alembic Ogawa
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OStream.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OGroup.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IStreams.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IGroup.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IArchive.cpp"

    # Alembic AbcCoreAbstract
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/TimeSampling.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/TimeSamplingType.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ObjectWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ReadArraySampleCache.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ObjectReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/Foundation.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/CompoundPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/CompoundPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/BasePropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArrayPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/BasePropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArraySample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArrayPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArchiveWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArchiveReader.cpp"

    # Alembic AbcCoreOgawa
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/WriteUtil.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/StreamManager.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/SpwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/SprImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ReadWrite.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ReadUtil.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OrData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/MetaDataMap.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OrImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OwData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CpwData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CprImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CprData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CpwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/AwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ArImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ApwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/AprImpl.cpp"

    # Alembic AbcCoreFactory
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreFactory/IFactory.cpp"

    # Alembic Abc
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/SourceName.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/Reference.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OScalarProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OCompoundProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OArrayProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OObject.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IScalarProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ISampleSelector.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IArrayProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IObject.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ICompoundProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ErrorHandler.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ArchiveInfo.cpp"

    # Alembic AbcGeom (only what we need: IPolyMesh + IXform + base types)
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/GeometryScope.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/Basis.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/CameraSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/ArchiveBounds.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/XformSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/XformOp.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/Visibility.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OPolyMesh.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OXform.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OPoints.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OFaceSet.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IPolyMesh.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IXform.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IFaceSet.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/FilmBackXformOp.cpp"

    # Glue (our JS-facing C ABI wrapper)
    "${CMAKE_SOURCE_DIR}/src/alembic_glue.cpp"
  )

  # Step 1: compile every source to .o in one command.
  # We pass all .cpp files to em++ at once — single compile + link pass.
  # -fexceptions enables C++ exception → JS propagation (required for Alembic
  # error handling to surface as readable JS exceptions instead of WASM traps).
  add_custom_command(
    OUTPUT  "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}"
    COMMAND "${EMSCRIPTEN_EMXX}"
            -O3
            -fexceptions
            -fvisibility=hidden -fdeclspec
            -DIMATH_DLL=0 -DALEMBIC_DLL=0
            ${ABC_LINK_FLAGS_BASE}
            ${ABC_LINK_FLAGS_WITH_EXCEPTIONS}
            -s EXPORTED_FUNCTIONS=${ABC_EXPORTED_FUNCTIONS}
            ${ABC_INCLUDE_DIRS}
            ${ABC_ALL_SOURCES}
            -o "${ABC_JS_OUTPUT}"
    DEPENDS ${ABC_ALL_SOURCES}
    COMMENT "Compiling + linking alembic.js + alembic.wasm (Phase 1, all-in-one)"
    VERBATIM
  )

  add_custom_target(abc_wasm_glue ALL DEPENDS "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}")

# ----------------------------------------------------------------------------
# Phase 2: wabc smoke test wasm.
# Verifies the new wabc C ABI entry points work correctly.
# No Alembic/Imath deps — just basic FFI tests (add, echo, version string).
# ----------------------------------------------------------------------------
elseif(ABC_PHASE STREQUAL "2")
  set(ABC_EXPORTED_FUNCTIONS "[_wabc_smoke_add,_wabc_smoke_version,_wabc_smoke_echo_int]")
  set(ABC_OBJ          "${ABC_OUT_DIR}/wabc_smoke.cpp.o")
  set(ABC_JS_OUTPUT    "${ABC_OUT_DIR}/wabc_smoke.js")
  set(ABC_WASM_OUTPUT  "${ABC_OUT_DIR}/wabc_smoke.wasm")

  add_custom_command(
    OUTPUT  "${ABC_OBJ}"
    COMMAND "${EMSCRIPTEN_EMXX}"
            -c -fvisibility=hidden -fno-exceptions -fno-rtti
            "${CMAKE_SOURCE_DIR}/src/wabc_smoke.cpp"
            -o "${ABC_OBJ}"
    DEPENDS "${CMAKE_SOURCE_DIR}/src/wabc_smoke.cpp"
    COMMENT "Compiling wabc_smoke.cpp (Phase 2)"
    VERBATIM
  )

  add_custom_command(
    OUTPUT  "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}"
    COMMAND "${EMSCRIPTEN_EMXX}"
            ${ABC_LINK_FLAGS_BASE}
            ${ABC_LINK_FLAGS_NO_EXCEPTIONS}
            -s EXPORTED_FUNCTIONS=${ABC_EXPORTED_FUNCTIONS}
            "${ABC_OBJ}"
            -o "${ABC_JS_OUTPUT}"
    DEPENDS "${ABC_OBJ}"
    COMMENT "Linking wabc_smoke.js + wabc_smoke.wasm (Phase 2)"
    VERBATIM
  )

  add_custom_target(wabc_wasm_smoke ALL DEPENDS "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}")

# ----------------------------------------------------------------------------
# Phase 3: wabc full wasm.
# Builds wabc_js_binding.cpp with SceneABC.cpp + SceneGraph.cpp + VectorMath.h
# + all Alembic + Imath sources.
# Outputs: wabc.js + wabc.wasm in build_wabc/ directory.
# JS-side EXPORT_NAME = WabcModule (separate from old AlembicModule).
# ----------------------------------------------------------------------------
elseif(ABC_PHASE STREQUAL "3")
  # Verify deps
  if(NOT EXISTS "${CMAKE_SOURCE_DIR}/alembic/CMakeLists.txt")
    message(FATAL_ERROR "Alembic source not found. Clone to wasm_src/alembic/ or run build.ps1 -InstallDeps -Phase 3.")
  endif()
  if(NOT EXISTS "${CMAKE_SOURCE_DIR}/Imath/src/Imath/half.h")
    message(FATAL_ERROR "Imath source not found. Clone to wasm_src/Imath/ or run build.ps1 -InstallDeps -Phase 3.")
  endif()

  set(ABC_EXPORTED_FUNCTIONS "[_wabc_open_buffer,_wabc_close,_wabc_get_start_time,_wabc_get_end_time,_wabc_seek,_wabc_get_num_vertices,_wabc_get_num_faces,_wabc_read_positions,_wabc_read_face_counts,_wabc_read_face_indices,_wabc_read_expanded_vertices,_wabc_read_wireframe_indices,_wabc_get_num_points,_wabc_read_points,_wabc_get_num_cameras,_wabc_read_camera,_wabc_get_camera_path,_wabc_get_num_scenes,_wabc_get_time,_wabc_cleanup,_wabc_dump_positions,_wabc_dump_structure,_wabc_has_geometry,_wabc_dump_after_seek,_wabc_dump_mesh_stats,_wabc_get_debug_matrices,_wabc_get_debug_matrix_count,_malloc,_free]")
  set(ABC_JS_OUTPUT    "${ABC_OUT_DIR}/wabc.js")
  set(ABC_WASM_OUTPUT  "${ABC_OUT_DIR}/wabc.wasm")

  set(WABC_ALL_SOURCES
    # Imath
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/half.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathColorAlgo.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathFun.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathMatrixAlgo.cpp"
    "${CMAKE_SOURCE_DIR}/Imath/src/Imath/ImathRandom.cpp"

    # Alembic Util
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/TokenMap.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/Naming.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/SpookyV2.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Util/Murmur3.cpp"

    # Alembic Ogawa
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OStream.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/OGroup.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IStreams.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IGroup.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Ogawa/IArchive.cpp"

    # Alembic AbcCoreAbstract
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/TimeSampling.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/TimeSamplingType.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ObjectWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ReadArraySampleCache.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ScalarPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ObjectReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/Foundation.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/CompoundPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/CompoundPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/BasePropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArrayPropertyWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/BasePropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArraySample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArrayPropertyReader.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArchiveWriter.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreAbstract/ArchiveReader.cpp"

    # Alembic AbcCoreOgawa
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/WriteUtil.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/StreamManager.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/SpwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/SprImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ReadWrite.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ReadUtil.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OrData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/MetaDataMap.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OrImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/OwData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CpwData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CprImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CprData.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/CpwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/AwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ArImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/ApwImpl.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreOgawa/AprImpl.cpp"

    # Alembic AbcCoreFactory
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcCoreFactory/IFactory.cpp"

    # Alembic Abc
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/SourceName.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/Reference.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OScalarProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OCompoundProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OArrayProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/OObject.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IScalarProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ISampleSelector.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IArrayProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IObject.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ICompoundProperty.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ErrorHandler.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/IArchive.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/Abc/ArchiveInfo.cpp"

    # Alembic AbcGeom (full: IPolyMesh, ICamera, IPoints, IXform)
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/GeometryScope.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/Basis.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/CameraSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/ArchiveBounds.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/XformSample.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/XformOp.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/Visibility.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OPolyMesh.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OXform.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OPoints.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/OFaceSet.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IPolyMesh.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IXform.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IFaceSet.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/FilmBackXformOp.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/ICamera.cpp"
    "${CMAKE_SOURCE_DIR}/alembic/lib/Alembic/AbcGeom/IPoints.cpp"

    # wabc C++ sources (from i-saint's WebAlembicViewer)
    # NOTE: SceneABC.cpp is included directly by wabc_js_binding.cpp via
    # #include "SceneABC.cpp", so do NOT add it here or you get duplicate symbols.
    "${CMAKE_SOURCE_DIR}/src/SceneGraph.cpp"

    # wabc JS binding (replaces alembic_glue.cpp; pulls in SceneABC.cpp via include)
    "${CMAKE_SOURCE_DIR}/src/wabc_js_binding.cpp"
  )

  # Build strategy: compile all sources to object files first, then link.
  # This avoids the Windows command-line length limit that causes the "||" and
  # "@path" expansion errors in single-pass compilation.
  # Phase 0 and Phase 2 use the same approach successfully.

  set(WABC_OBJ_DIR "${CMAKE_BINARY_DIR}/objs")
  file(MAKE_DIRECTORY "${WABC_OBJ_DIR}")

  # Write the exported functions list for linking.
  file(WRITE "${WABC_OBJ_DIR}/exported_functions.txt"
    "_wabc_open_buffer\n_wabc_close\n_wabc_get_start_time\n_wabc_get_end_time\n_wabc_seek\n_wabc_get_num_vertices\n_wabc_get_num_faces\n_wabc_read_positions\n_wabc_read_face_counts\n_wabc_read_face_indices\n_wabc_read_expanded_vertices\n_wabc_read_wireframe_indices\n_wabc_get_num_points\n_wabc_read_points\n_wabc_get_num_cameras\n_wabc_read_camera\n_wabc_get_camera_path\n_wabc_get_num_scenes\n_wabc_get_time\n_wabc_cleanup\n_wabc_dump_positions\n_wabc_dump_structure\n_wabc_has_geometry\n_wabc_dump_after_seek\n_wabc_dump_mesh_stats\n_wabc_get_debug_matrices\n_wabc_get_debug_matrix_count\n_malloc\n_free\n"
  )
  file(WRITE "${WABC_OBJ_DIR}/exported_runtime_methods.txt"
    "cwrap\nstackAlloc\nstackSave\nstackRestore\n"
  )

  # Compile each source file to an object file.
  # Use VERBATIM to ensure proper escaping of paths with spaces.
  # Object files go under objs/ preserving relative source directory structure.
  set(WABC_OBJ_FILES "")
  foreach(_src ${WABC_ALL_SOURCES})
    # Create output dir mirroring source dir structure
    file(RELATIVE_PATH _rel_src "${CMAKE_SOURCE_DIR}" "${_src}")
    string(REPLACE "/" "_" _rel_src_underscored "${_rel_src}")
    string(REPLACE "\\" "_" _rel_src_underscored "${_rel_src_underscored}")
    set(_obj "${WABC_OBJ_DIR}/${_rel_src_underscored}.o")
    list(APPEND WABC_OBJ_FILES "${_obj}")
    add_custom_command(
      OUTPUT  "${_obj}"
      COMMAND "${EMSCRIPTEN_EMXX}"
              -c -O3 -fexceptions
              -fvisibility=hidden -fdeclspec
              -DIMATH_DLL=0 -DALEMBIC_DLL=0
              ${ABC_INCLUDE_DIRS}
              "${_src}"
              -o "${_obj}"
      DEPENDS "${_src}"
      COMMENT "Compiling ${_rel_src}"
      VERBATIM
    )
  endforeach()

  # Write the object files list to a response file to avoid command-line length limits.
  # CMake lists use ';' as separator; replace with newlines for response file format.
  string(REPLACE ";" "\n" _objects_text "${WABC_OBJ_FILES}")
  file(WRITE "${WABC_OBJ_DIR}/objects_list.txt" "${_objects_text}")

  # Generate a batch file that invokes em++ directly.
  # This sidesteps cmake/ninja's argument quoting (which would mangle @-prefixed
  # response-file paths by wrapping them in double quotes).
  #
  # CRITICAL: emcc's response-file parser splits the @-path on the first whitespace,
  # so paths containing spaces (like our workspace path) MUST be passed in quoted form.
  # Generate response files in a directory without spaces to avoid emcc's
  # response-file parser splitting paths on whitespace.
  set(_rsp_dir "$ENV{TEMP}/wabc_rsp_${CMAKE_BINARY_DIR_HASH}")
  file(MAKE_DIRECTORY "${_rsp_dir}")
  # Wrap each object path in double quotes so emcc's shlex.split treats them as
  # single arguments even when they contain spaces.
  set(_objects_text "")
  foreach(_obj ${WABC_OBJ_FILES})
    if(_objects_text STREQUAL "")
      set(_objects_text "\"${_obj}\"")
    else()
      set(_objects_text "${_objects_text}\n\"${_obj}\"")
    endif()
  endforeach()
  file(WRITE "${_rsp_dir}/objs.txt" "${_objects_text}")
  file(WRITE "${_rsp_dir}/funcs.txt"
    "_wabc_open_buffer\n_wabc_close\n_wabc_get_start_time\n_wabc_get_end_time\n_wabc_seek\n_wabc_get_num_vertices\n_wabc_get_num_faces\n_wabc_read_positions\n_wabc_read_face_counts\n_wabc_read_face_indices\n_wabc_read_expanded_vertices\n_wabc_read_wireframe_indices\n_wabc_get_num_points\n_wabc_read_points\n_wabc_get_num_cameras\n_wabc_read_camera\n_wabc_get_camera_path\n_wabc_get_num_scenes\n_wabc_get_time\n_wabc_cleanup\n_wabc_dump_positions\n_wabc_dump_structure\n_wabc_has_geometry\n_wabc_dump_after_seek\n_wabc_dump_mesh_stats\n_wabc_get_debug_matrices\n_wabc_get_debug_matrix_count\n_malloc\n_free\n"
  )

  # Generate a batch file that invokes em++ directly.
  # emcc's response-file parser splits @-paths on whitespace, so we use a
  # directory without spaces for the response files.
  set(_link_bat "${CMAKE_BINARY_DIR}/link_wabc.bat")
  file(WRITE "${_link_bat}"
    "@echo off\r\n"
    "\"${EMSCRIPTEN_EMXX}\" -O3 -fvisibility=hidden -fdeclspec -s MODULARIZE=1 -s EXPORT_NAME=WabcModule -s ALLOW_MEMORY_GROWTH=1 -s FORCE_FILESYSTEM=1 -s EXPORTED_RUNTIME_METHODS=cwrap,stackAlloc,stackSave,stackRestore -s EXPORTED_FUNCTIONS=@${_rsp_dir}/funcs.txt @${_rsp_dir}/objs.txt -o \"${ABC_JS_OUTPUT}\"\r\n"
    "exit /B %ERRORLEVEL%\r\n"
  )

  # Link all object files into the final wasm.
  add_custom_command(
    OUTPUT  "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}"
    COMMAND "${_link_bat}"
    DEPENDS ${WABC_OBJ_FILES} "${_link_bat}" "${_rsp_dir}/objs.txt" "${_rsp_dir}/funcs.txt"
    COMMENT "Linking wabc.js + wabc.wasm (Phase 3)"
    VERBATIM
  )

  add_custom_target(wabc_wasm_full ALL DEPENDS "${ABC_JS_OUTPUT}" "${ABC_WASM_OUTPUT}")
endif()
