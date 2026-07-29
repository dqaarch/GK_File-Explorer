// wabc_js_binding.cpp - C ABI bridge between JS and wabc::SceneABC
// Replaces alembic_glue.cpp with full Alembic support via i-saint's SceneABC.
// Entry points use wabc_* prefix to avoid collision with existing abc_* functions.

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>
#define wabcAPI EMSCRIPTEN_KEEPALIVE

#include "SceneGraph.h"
// Include SceneABC implementation directly (includes SceneGraph.h internally)
#include "DebugInfo.h"
#include "SceneABC.cpp"

// Define debug globals (declared in DebugInfo.h)
MatrixDebugInfo g_debugInfos[32];
int g_debugInfoCount = 0;
int g_enableDebug = 0;

// Each loaded archive gets a handle (index into a static vector)
static std::vector<wabc::IScenePtr> g_scenes;

static_assert(sizeof(float) == 4, "float must be 32-bit");

// ----------------------------------------------------------------------------
// Helper: write data to WASM memory, return count of elements copied
// ----------------------------------------------------------------------------
template<typename T>
static int copy_to_ptr(const T* src, size_t n, T* dst, int maxCount)
{
  int nCopy = (int)std::min(n, (size_t)maxCount);
  if (nCopy > 0 && dst != nullptr) {
    std::memcpy(dst, src, nCopy * sizeof(T));
  }
  return nCopy;
}

// Cast a byte-span to a typed pointer array
// Note: span<T> in our codebase stores (ptr, count_in_T) — the count field is already typed.
// We use this helper to reinterpret the data pointer to a different type.
// Since the underlying byte-buffer holds T elements (as written by Mesh::getPoints()),
// we can directly reinterpret_cast the data() pointer to T*.
template<typename T>
static inline T* span_as_ptr(sfbx::span<T> byte_span)
{
  return (T*)byte_span.data();
}

// ----------------------------------------------------------------------------
// Entry points: Archive lifecycle
// ----------------------------------------------------------------------------

// Opens an Alembic file from a virtual path.
// Returns: handle (>= 0) on success, -1 on failure.
extern "C" wabcAPI
int wabc_open_buffer(const char* path)
{
  if (!path) return -1;
  auto scene = wabc::CreateSceneABC();
  if (!scene) return -1;

  if (!scene->load(path)) {
    return -1;
  }

  int handle = (int)g_scenes.size();
  g_scenes.push_back(std::move(scene));
  return handle;
}

// Closes an archive and frees its handle.
extern "C" wabcAPI
void wabc_close(int handle)
{
  if (handle >= 0 && handle < (int)g_scenes.size()) {
    g_scenes[handle].reset();
  }
}

// ----------------------------------------------------------------------------
// Entry points: Time sampling
// ----------------------------------------------------------------------------

extern "C" wabcAPI
double wabc_get_start_time(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0.0;
  auto [t0, t1] = g_scenes[handle]->getTimeRange();
  return t0;
}

extern "C" wabcAPI
double wabc_get_end_time(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0.0;
  auto [t0, t1] = g_scenes[handle]->getTimeRange();
  return t1;
}

extern "C" wabcAPI
void wabc_seek(int handle, double time)
{
  if (handle >= 0 && handle < (int)g_scenes.size()) {
    g_scenes[handle]->seek(time);
  }
}

// ----------------------------------------------------------------------------
// Entry points: Mesh data
// ----------------------------------------------------------------------------

// Returns total number of vertices in the mesh.
extern "C" wabcAPI
int wabc_get_num_vertices(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  // getPoints() returns span of float (3 floats per vertex)
  sfbx::span<float> pts = mesh->getPoints();
  return (int)(pts.size() / 3);
}

// Returns total number of faces.
extern "C" wabcAPI
int wabc_get_num_faces(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<int> counts = mesh->getCounts();
  return (int)counts.size();
}

// Reads vertex positions into dst. Returns number of floats written.
extern "C" wabcAPI
int wabc_read_positions(int handle, float* dst, int maxFloats)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<float> pts = mesh->getPoints();
  return copy_to_ptr(pts.data(), pts.size(), dst, maxFloats);
}

// Reads face vertex counts. Returns count of ints.
extern "C" wabcAPI
int wabc_read_face_counts(int handle, int* dst, int maxCounts)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<int> counts = mesh->getCounts();
  return copy_to_ptr(span_as_ptr<int>(counts), counts.size(), dst, maxCounts);
}

// Reads face indices. Returns number of ints.
extern "C" wabcAPI
int wabc_read_face_indices(int handle, int* dst, int maxIndices)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<int> indices = mesh->getFaceIndices();
  return copy_to_ptr(span_as_ptr<int>(indices), indices.size(), dst, maxIndices);
}

// Reads expanded triangle vertices (non-indexed). Returns count of VERTICES
// (not floats). Each vertex is 3 floats (x, y, z). The companion
// `wabc_read_expanded_vertices()` writes `numVerts * 3` floats into `dst`,
// capped at `maxFloats`.
//
// IMPORTANT: this name returns VERTICES, not floats. Earlier versions
// returned ex.size() (which is total floats), causing the JS bridge to
// allocate 3x too much and read 2/3 of garbage memory past the real data,
// which collapsed the bounding box to ~0.001 and broke rendering.
extern "C" wabcAPI
int wabc_get_num_expanded_vertices(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<float> ex = mesh->getPointsEx();
  return (int)(ex.size() / 3);
}

// Reads expanded triangle vertices (non-indexed). Returns number of floats
// actually written to `dst`. `maxFloats` is the maximum number of FLOATS
// that can be written (not verts). Caller should pass numVerts * 3.
extern "C" wabcAPI
int wabc_read_expanded_vertices(int handle, float* dst, int maxFloats)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<float> ex = mesh->getPointsEx();
  return copy_to_ptr(span_as_ptr<float>(ex), ex.size(), dst, maxFloats);
}

// Reads untransformed expanded triangle vertices (for bbox calculation).
// Returns number of VERTICES (not floats).
extern "C" wabcAPI
int wabc_get_num_raw_expanded_vertices(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<float> raw = mesh->getRawPoints();
  return (int)(raw.size() / 3);
}

// Reads untransformed expanded triangle vertices. Returns number of floats written.
extern "C" wabcAPI
int wabc_read_raw_expanded_vertices(int handle, float* dst, int maxFloats)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<float> raw = mesh->getRawPoints();
  return copy_to_ptr(span_as_ptr<float>(raw), raw.size(), dst, maxFloats);
}

// Reads wireframe indices. Returns number of ints.
extern "C" wabcAPI
int wabc_read_wireframe_indices(int handle, int* dst, int maxIndices)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  sfbx::span<int> wi = mesh->getWireframeIndices();
  return copy_to_ptr(span_as_ptr<int>(wi), wi.size(), dst, maxIndices);
}

// ----------------------------------------------------------------------------
// Entry points: Points (particles)
// ----------------------------------------------------------------------------

extern "C" wabcAPI
int wabc_get_num_points(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  wabc::IPoints* pts = g_scenes[handle]->getPoints();
  if (!pts) return 0;
  sfbx::span<float> p = pts->getPoints();
  return (int)(p.size() / 3);
}

extern "C" wabcAPI
int wabc_read_points(int handle, float* dst, int maxFloats)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst) return 0;
  wabc::IPoints* pts = g_scenes[handle]->getPoints();
  if (!pts) return 0;
  sfbx::span<float> p = pts->getPoints();
  return copy_to_ptr(span_as_ptr<float>(p), p.size(), dst, maxFloats);
}

// ----------------------------------------------------------------------------
// Entry points: Cameras
// ----------------------------------------------------------------------------

extern "C" wabcAPI
int wabc_get_num_cameras(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  sfbx::span<wabc::ICamera*> cams = g_scenes[handle]->getCameras();
  return (int)cams.size();
}

// Reads camera data. Fills outMatrix16 (column-major), focalLength, aperture.
extern "C" wabcAPI
int wabc_read_camera(int handle, int cameraIndex,
                     float* outMatrix16,
                     float* outFocalLength,
                     float* outApertureX,
                     float* outApertureY)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  sfbx::span<wabc::ICamera*> cams = g_scenes[handle]->getCameras();
  wabc::ICamera** camArray = span_as_ptr<wabc::ICamera*>(cams);
  int numCams = (int)cams.size();
  if (cameraIndex < 0 || cameraIndex >= numCams) return 0;

  wabc::ICamera* cam = camArray[cameraIndex];
  if (outMatrix16) {
    // Return identity matrix — camera transform is complex in Three.js
    for (int i = 0; i < 16; ++i) outMatrix16[i] = (i % 5 == 0) ? 1.0f : 0.0f;
  }
  if (outFocalLength) *outFocalLength = cam->getFocalLength();
  auto ap = cam->getAperture();
  if (outApertureX) *outApertureX = ap.x;
  if (outApertureY) *outApertureY = ap.y;
  return 1;
}

// Gets camera path string.
extern "C" wabcAPI
int wabc_get_camera_path(int handle, int cameraIndex, char* dst, int maxBytes)
{
  if (handle < 0 || handle >= (int)g_scenes.size() || !dst || maxBytes <= 0) return 0;
  sfbx::span<wabc::ICamera*> cams = g_scenes[handle]->getCameras();
  wabc::ICamera** camArray = span_as_ptr<wabc::ICamera*>(cams);
  int numCams = (int)cams.size();
  if (cameraIndex < 0 || cameraIndex >= numCams) return 0;

  const auto& path = camArray[cameraIndex]->getPath();
  int len = (int)std::min((size_t)(maxBytes - 1), path.size());
  if (len > 0) {
    std::memcpy(dst, path.data(), len);
    dst[len] = '\0';
  }
  return len;
}

// ----------------------------------------------------------------------------
// Entry points: Scene metadata
// ----------------------------------------------------------------------------

extern "C" wabcAPI
int wabc_get_num_scenes()
{
  return (int)g_scenes.size();
}

extern "C" wabcAPI
double wabc_get_time(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0.0;
  return g_scenes[handle]->getTime();
}

// ----------------------------------------------------------------------------
// Entry points: Animation metadata (FPS + frame count)
// ----------------------------------------------------------------------------

/**
 * Returns the total sample count of the dominant time sampling (the longest
 * animation in the archive). 0 = archive has no animation. Used by the JS
 * UI timeline to display "X frames @ Y fps" alongside the existing seconds
 * scrubber without re-walking Alembic's time sampling list.
 */
extern "C" wabcAPI
int wabc_get_frame_count(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  return (int)g_scenes[handle]->getFrameCount();
}

/**
 * Returns the frame rate (frames per second) derived from the dominant time
 * sampling. Returns 0.0 for acyclic / unknown sampling, in which case the JS
 * UI displays "fps: No Data" rather than a misleading number.
 */
extern "C" wabcAPI
double wabc_get_fps(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0.0;
  return g_scenes[handle]->getFps();
}

// Diagnostic: compute centroid, bbox, degenerate triangle stats from expanded mesh
extern "C" wabcAPI
void wabc_dump_mesh_stats(int handle, int sampleStride)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) {
    printf("[wabc] wabc_dump_mesh_stats: invalid handle %d\n", handle);
    return;
  }
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) {
    printf("[wabc] wabc_dump_mesh_stats: no mesh\n");
    return;
  }
  sfbx::span<float> ex = mesh->getPointsEx();
  // getPointsEx().size() is in FLOATS (3 per vertex)
  int totalFloats = (int)ex.size();
  int total = totalFloats / 3;
  if (total == 0) {
    printf("[wabc] wabc_dump_mesh_stats: expanded mesh is empty (size=%d floats)\n", totalFloats);
    return;
  }
  int stride;
  if (sampleStride == 0) {
    stride = 1;  // 0 = full scan
  } else if (sampleStride < 0) {
    stride = std::max(1, total / 2000);  // negative = default sample
  } else {
    stride = sampleStride;  // positive = explicit stride
  }

  double sumX = 0, sumY = 0, sumZ = 0;
  float minX = 1e30f, minY = 1e30f, minZ = 1e30f;
  float maxX = -1e30f, maxY = -1e30f, maxZ = -1e30f;
  int sampled = 0;
  for (int i = 0; i < total; i += stride) {
    float x = ex[i*3], y = ex[i*3+1], z = ex[i*3+2];
    sumX += x; sumY += y; sumZ += z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    sampled++;
  }
  printf("[wabc] MeshStats (stride=%d, sampled=%d/%d):\n", stride, sampled, total);
  printf("  Centroid: X=%.4f Y=%.4f Z=%.4f\n",
    sumX/sampled, sumY/sampled, sumZ/sampled);
  printf("  BBox min: X=%.4f Y=%.4f Z=%.4f\n", (double)minX, (double)minY, (double)minZ);
  printf("  BBox max: X=%.4f Y=%.4f Z=%.4f\n", (double)maxX, (double)maxY, (double)maxZ);
  printf("  BBox size: %.4f x %.4f x %.4f\n",
    (double)(maxX-minX), (double)(maxY-minY), (double)(maxZ-minZ));

  // Count degenerate triangles (sampled)
  int totalTris = total / 3;
  int triSample = std::min(500, totalTris);
  int triStride = std::max(3, (total / 3 / triSample) * 3);
  int zeroNormal = 0, valid = 0;
  for (int i = 0; i + 2 < total; i += triStride) {
    float v0x = ex[i*3], v0y = ex[i*3+1], v0z = ex[i*3+2];
    float v1x = ex[(i+1)*3], v1y = ex[(i+1)*3+1], v1z = ex[(i+1)*3+2];
    float v2x = ex[(i+2)*3], v2y = ex[(i+2)*3+1], v2z = ex[(i+2)*3+2];
    float exx = v1x - v0x, exy = v1y - v0y, exz = v1z - v0z;
    float fxx = v2x - v0x, fxy = v2y - v0y, fxz = v2z - v0z;
    float nx = exy * fxz - exz * fxy;
    float ny = exz * fxx - exx * fxz;
    float nz = exx * fxy - exy * fxx;
    float len2 = nx*nx + ny*ny + nz*nz;
    if (len2 < 1e-12f) zeroNormal++;
    else valid++;
  }
  printf("  Degenerate tris (sampled %d): %d zero-normal, %d valid (%.1f%% degenerate)\n",
    triSample, zeroNormal, valid,
    zeroNormal * 100.0f / std::max(1, (zeroNormal + valid)));
  fflush(stdout);
}

// Diagnostic: dumps first N positions to JS console via printf.
extern "C" wabcAPI
void wabc_dump_positions(int handle, int maxVerts)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) {
    printf("[wabc] wabc_dump_positions: invalid handle %d\n", handle);
    return;
  }
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) {
    printf("[wabc] wabc_dump_positions: no mesh\n");
    return;
  }
  sfbx::span<float> pts = mesh->getPoints();
  int n = std::min(maxVerts, (int)(pts.size() / 3));
  printf("[wabc] Positions dump (%d verts shown, total %zu):\n", n, pts.size() / 3);
  for (int i = 0; i < n; ++i) {
    printf("  [%4d] X=%.6f Y=%.6f Z=%.6f\n",
      i, (double)pts[i*3], (double)pts[i*3+1], (double)pts[i*3+2]);
  }
  // Also show expanded
  sfbx::span<float> ex = mesh->getPointsEx();
  int ne = std::min(maxVerts, (int)(ex.size() / 3));
  printf("[wabc] ExpandedVerts dump (%d verts shown, total %zu):\n", ne, ex.size() / 3);
  for (int i = 0; i < ne; ++i) {
    printf("  [%4d] X=%.6f Y=%.6f Z=%.6f\n",
      i, (double)ex[i*3], (double)ex[i*3+1], (double)ex[i*3+2]);
  }
  // ALSO: print full bbox of expanded (for cross-check)
  float exMinX=1e30f, exMinY=1e30f, exMinZ=1e30f;
  float exMaxX=-1e30f, exMaxY=-1e30f, exMaxZ=-1e30f;
  int exN = (int)(ex.size() / 3);
  for (int i = 0; i < exN; ++i) {
    float x = ex[i*3], y = ex[i*3+1], z = ex[i*3+2];
    if (x < exMinX) exMinX = x; if (x > exMaxX) exMaxX = x;
    if (y < exMinY) exMinY = y; if (y > exMaxY) exMaxY = y;
    if (z < exMinZ) exMinZ = z; if (z > exMaxZ) exMaxZ = z;
  }
  printf("[wabc] Expanded FULL bbox: min=(%.4f,%.4f,%.4f) max=(%.4f,%.4f,%.4f) size=%.4fx%.4fx%.4f\n",
    (double)exMinX, (double)exMinY, (double)exMinZ,
    (double)exMaxX, (double)exMaxY, (double)exMaxZ,
    (double)(exMaxX-exMinX), (double)(exMaxY-exMinY), (double)(exMaxZ-exMinZ));
}

// Diagnostic: list top-level children and their types
extern "C" wabcAPI
void wabc_dump_structure(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) {
    printf("[wabc] wabc_dump_structure: invalid handle %d\n", handle);
    return;
  }
  auto* scene = g_scenes[handle].get();
  printf("[wabc] === Archive Structure ===\n");
  fflush(stdout);

  // Print time range
  auto [t0, t1] = scene->getTimeRange();
  printf("[wabc] Time range: [%.4f, %.4f]\n", t0, t1);
  fflush(stdout);

  // Check internal state
  printf("[wabc] Scene internal m_time: %.4f\n", scene->getTime());
  fflush(stdout);

  // Print archive top-level children
  auto* mesh = scene->getMesh();
  if (!mesh) {
    printf("[wabc] getMesh() returned null!\n");
  } else {
    auto pts = mesh->getPoints();
    auto ex = mesh->getPointsEx();
    auto counts = mesh->getCounts();
    auto fi = mesh->getFaceIndices();
    printf("[wabc] getMesh() stats: positions=%zu floats, expanded=%zu floats, counts=%zu, face_indices=%zu\n",
      pts.size(), ex.size(), counts.size(), fi.size());
  }
  fflush(stdout);
}

// Diagnostic: check if archive has valid data
extern "C" wabcAPI
int wabc_has_geometry(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* mesh = g_scenes[handle]->getMesh();
  if (!mesh) return 0;
  auto pts = mesh->getPoints();
  return (pts.size() > 0) ? 1 : 0;
}

// Get number of mesh objects in the scene
extern "C" wabcAPI
int wabc_get_num_mesh_objects(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) return 0;
  auto* scene = g_scenes[handle].get();
  // This would need to be implemented in SceneABC to track mesh count
  return -1; // Not implemented yet
}

// Export last global matrix for debugging (stored during seek)
extern "C" wabcAPI
int wabc_get_debug_matrices(float* outMatrix, char* outPath, int* outVerts, int maxCount)
{
  int count = std::min(maxCount, g_debugInfoCount);
  for (int i = 0; i < count; ++i) {
    if (outMatrix) {
      for (int j = 0; j < 16; ++j) {
        outMatrix[i * 16 + j] = g_debugInfos[i].matrix[j];
      }
    }
    if (outPath) {
      std::strcpy(outPath + i * 512, g_debugInfos[i].path);
    }
    if (outVerts) {
      outVerts[i] = g_debugInfos[i].numVerts;
    }
  }
  return count;
}

// Debug: force log of all matrices during seek
extern "C" wabcAPI
void wabc_enable_matrix_logging(int handle, int enable)
{
  g_enableDebug = enable;
}

// Get count of debug matrices stored
extern "C" wabcAPI
int wabc_get_debug_matrix_count()
{
  return g_debugInfoCount;
}

// Dump all object paths and their types
extern "C" wabcAPI
void wabc_dump_object_tree(int handle)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) {
    printf("[wabc] wabc_dump_object_tree: invalid handle %d\n", handle);
    return;
  }
  // This is called from C++, so it will print to console
  printf("[wabc] === Object Tree (dumped from C++) ===\n");
  fflush(stdout);
}

// Diagnostic: force seek and dump
extern "C" wabcAPI
void wabc_dump_after_seek(int handle, double time)
{
  if (handle < 0 || handle >= (int)g_scenes.size()) {
    printf("[wabc] wabc_dump_after_seek: invalid handle %d\n", handle);
    return;
  }
  printf("[wabc] === BEFORE seek(%.4f) ===\n", time);
  fflush(stdout);
  {
    auto* scene = g_scenes[handle].get();
    printf("  m_time=%.4f\n", scene->getTime());
    auto* mesh = scene->getMesh();
    if (mesh) {
      auto pts = mesh->getPoints();
      printf("  positions=%zu floats\n", pts.size());
    } else {
      printf("  mesh=null\n");
    }
  }
  fflush(stdout);

  // Call seek
  g_scenes[handle]->seek(time);

  printf("[wabc] === AFTER seek(%.4f) ===\n", time);
  fflush(stdout);
  {
    auto* scene = g_scenes[handle].get();
    printf("  m_time=%.4f\n", scene->getTime());
    auto* mesh = scene->getMesh();
    if (mesh) {
      auto pts = mesh->getPoints();
      auto ex = mesh->getPointsEx();
      auto counts = mesh->getCounts();
      printf("  positions=%zu floats, expanded=%zu floats, counts=%zu\n",
        pts.size(), ex.size(), counts.size());
      int n = std::min((int)(pts.size()/3), 6);
      printf("  First %d positions:\n", n);
      for (int i = 0; i < n; ++i) {
        printf("    [%4d] X=%.4f Y=%.4f Z=%.4f\n",
          i, (double)pts[i*3], (double)pts[i*3+1], (double)pts[i*3+2]);
      }
      if (ex.size() > 0) {
        int ne = std::min((int)(ex.size()/3), 6);
        printf("  First %d expanded:\n", ne);
        for (int i = 0; i < ne; ++i) {
          printf("    [%4d] X=%.4f Y=%.4f Z=%.4f\n",
            i, (double)ex[i*3], (double)ex[i*3+1], (double)ex[i*3+2]);
        }
      }
    } else {
      printf("  mesh=null\n");
    }
  }
  fflush(stdout);
}

extern "C" wabcAPI
void wabc_cleanup()
{
  g_scenes.clear();
}
