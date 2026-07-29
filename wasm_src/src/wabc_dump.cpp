// wabc_dump.cpp - Phase 2 diagnostic dump
// Reads RunningCharacter.abc and prints mesh data to console for comparison
// with i-saint's output.

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>

#include "wabc.h"
#include "SceneGraph.h"
#include "SceneABC.cpp"

// Simple hex dump of the first 24 floats of position data
static void dump_positions(const char* label, const float* data, int count) {
    printf("[DUMP] %s (first %d floats, 3 per vertex):\n", label, std::min(count, 24));
    int show = std::min(count, 24);
    for (int i = 0; i < show; i += 3) {
        printf("  [%4d] %.6f  %.6f  %.6f\n", i/3,
            (double)data[i], (double)data[i+1], (double)data[i+2]);
    }
    if (show < count) printf("  ... (%d more vertices)\n", (count - show)/3);
    fflush(stdout);
}

static void dump_counts(const char* label, const int* data, int count) {
    printf("[DUMP] %s (first %d ints):\n", label, std::min(count, 24));
    int show = std::min(count, 24);
    for (int i = 0; i < show; i++) {
        printf("  [%4d] %d\n", i, data[i]);
    }
    if (show < count) printf("  ... (%d more)\n", count - show);
    fflush(stdout);
}

static void dump_indices(const char* label, const int* data, int count) {
    printf("[DUMP] %s (first %d ints):\n", label, std::min(count, 48));
    int show = std::min(count, 48);
    for (int i = 0; i < show; i++) {
        printf("  [%4d] %d\n", i, data[i]);
    }
    if (show < count) printf("  ... (%d more)\n", count - show);
    fflush(stdout);
}

extern "C" int wabc_dump(const char* path) {
    printf("[DUMP] === wabc_dump ===\n");
    fflush(stdout);

    // Load archive
    auto scene = wabc::CreateSceneABC();
    if (!scene) {
        printf("[DUMP] ERROR: CreateSceneABC returned null\n");
        fflush(stdout);
        return -1;
    }

    if (!scene->load(path)) {
        printf("[DUMP] ERROR: Failed to load archive: %s\n", path);
        fflush(stdout);
        return -1;
    }

    auto [t0, t1] = scene->getTimeRange();
    printf("[DUMP] Time range: [%.4f, %.4f]\n", t0, t1);
    fflush(stdout);

    // Seek to start
    scene->seek(t0);

    // Get mesh
    auto* mesh = scene->getMesh();
    if (!mesh) {
        printf("[DUMP] ERROR: getMesh() returned null\n");
        fflush(stdout);
        return -2;
    }

    // Read positions (local space)
    {
        auto pts = mesh->getPoints();
        printf("[DUMP] Positions: %zu verts (local space)\n", pts.size() / 3);
        fflush(stdout);
        if (!pts.empty()) {
            dump_positions("Positions (local)", pts.data(), (int)pts.size());
        }
    }

    // Read expanded vertices
    {
        auto ex = mesh->getPointsEx();
        printf("[DUMP] Expanded vertices: %zu floats (%d triangles)\n", ex.size(), (int)(ex.size() / 9));
        fflush(stdout);
        if (!ex.empty()) {
            dump_positions("ExpandedVerts[0..5]", ex.data(), 18); // first 6 verts
        }
    }

    // Read face counts
    {
        auto counts = mesh->getCounts();
        printf("[DUMP] Face counts: %zu faces\n", counts.size());
        fflush(stdout);
        if (!counts.empty()) {
            dump_counts("FaceCounts", counts.data(), (int)counts.size());
        }
    }

    // Read face indices
    {
        auto fi = mesh->getFaceIndices();
        printf("[DUMP] Face indices: %zu ints\n", fi.size());
        fflush(stdout);
        if (!fi.empty()) {
            dump_indices("FaceIndices", fi.data(), (int)fi.size());
        }
    }

    // Read wireframe indices
    {
        auto wi = mesh->getWireframeIndices();
        printf("[DUMP] Wireframe indices: %zu ints\n", wi.size());
        fflush(stdout);
        if (!wi.empty()) {
            dump_indices("WireIndices", wi.data(), (int)std::min((size_t)48, wi.size()));
        }
    }

    // Try seek to t0+0.5*(t1-t0) (mid-animation)
    if (t1 > t0) {
        double mid = t0 + (t1 - t0) * 0.5;
        printf("\n[DUMP] === Seeking to t=%.4f ===\n", mid);
        fflush(stdout);
        scene->seek(mid);

        auto pts2 = mesh->getPoints();
        printf("[DUMP] Mid-frame Positions: %zu verts\n", pts2.size() / 3);
        if (!pts2.empty()) {
            dump_positions("MidFrame Positions", pts2.data(), 18);
        }

        auto ex2 = mesh->getPointsEx();
        printf("[DUMP] Mid-frame Expanded: %zu floats\n", ex2.size());
        if (!ex2.empty()) {
            dump_positions("MidFrame Expanded[0..5]", ex2.data(), 18);
        }
    }

    printf("[DUMP] === DONE ===\n");
    fflush(stdout);
    return 0;
}
