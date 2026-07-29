// SceneABC.cpp - Alembic scene loader for wabc
// Adapted from i-saint/WebAlembicViewer/src/SceneABC.cpp
// Uses Alembic SDK directly (like i-saint) - transforms are applied correctly

#include "SceneGraph.h"
#include "DebugInfo.h"
#include <fstream>
#include <cmath>
#include <Alembic/Abc/All.h>
#include <Alembic/AbcCoreOgawa/All.h>
#include <Alembic/AbcGeom/All.h>
#include <emscripten.h>
#include <emscripten/console.h>

namespace wabc {

class SceneABC : public IScene
{
public:
  struct ImportContext {
    Alembic::Abc::IObject obj;
    double time = 0.0;
    float4x4 local_matrix = float4x4::identity();
    float4x4 global_matrix = float4x4::identity();
  };

  void release() override { delete this; }

  bool load(const char* path) override;
  bool loadAdditive(const char* path) override { return false; }
  void unload() override;

  std::tuple<double, double> getTimeRange() const override { return m_time_range; }
  /**
   * Returns the frame count of the dominant time sampling (largest sample count).
   * Returns 0 if the archive has no animation. Matches the actual on-disk sample
   * count, not the (capped) 30-sample times[] we expose to JS for scrubbing.
   */
  uint32_t getFrameCount() const override;
  /**
   * Returns the frame rate (frames per second) derived from the dominant time
   * sampling. Returns 0.0 for acyclic / unknown sampling. For uniform sampling,
   * fps = (num_samples_per_cycle * num_cycles - 1) / (time_end - time_start).
   */
  double getFps() const override;
  void seek(double time) override;

  double getTime() const override { return m_time; }
  IMesh* getMesh() override { return m_mono_mesh.get(); }
  IPoints* getPoints() override { return m_mono_points.get(); }
  sfbx::span<ICamera*> getCameras() override {
    return sfbx::span<ICamera*>(m_cameras.data(), (int)m_cameras.size());
  }

private:
  void scanNodes(ImportContext ctx);
  void seekImpl(ImportContext ctx);

  std::shared_ptr<std::fstream> m_stream;
  Alembic::Abc::IArchive m_archive;
  std::map<void*, size_t> m_sample_counts;
  std::tuple<double, double> m_time_range{ 0.0, 0.0 };
  // Dominant time sampling (largest sample count) cached at load() so the
  // JS side can read FPS/frame count without re-walking the time samplings.
  uint32_t m_dominant_frame_count = 0;   // total samples in dominant time sampling
  double   m_dominant_fps = 0.0;         // 0.0 = acyclic / unknown
  bool     m_dominant_acyclic = false;   // true when we cannot derive FPS
  uint32_t m_dominant_num_cycles = 0;

  double m_time = -1.0;
  MeshPtr m_mono_mesh;
  PointsPtr m_mono_points;

  std::map<std::string, CameraPtr> m_camera_table;
  std::vector<ICamera*> m_cameras;
};

template<class T>
inline sfbx::span<T> make_span(Alembic::Util::shared_ptr<Alembic::Abc::TypedArraySample<T>> s)
{
  if (s)
    return sfbx::span<T>((T*)s->get(), (size_t)s->size());
  else
    return sfbx::span<T>((T*)nullptr, (size_t)0);
}

template<class Cont> inline auto expand(Cont& v, size_t n)
{
  size_t pos = v.size();
  v.resize(pos + n);
  return v.data() + pos;
}

void SceneABC::unload()
{
  m_archive = {};
  m_stream = {};

  m_sample_counts = {};
  m_time_range = {};
  m_dominant_frame_count = 0;
  m_dominant_fps = 0.0;
  m_dominant_acyclic = false;
  m_dominant_num_cycles = 0;

  m_time = -1.0;
  m_mono_mesh = {};
  m_mono_points = {};

  m_cameras = {};
  m_camera_table = {};
}

bool SceneABC::load(const char* path)
{
  unload();

  try {
    m_stream.reset(new std::fstream());
    m_stream->open(path, std::ios::in | std::ios::binary);
    if (!m_stream->is_open()) {
      // printf("[wabc] SceneABC::load() failed to open: %s\n", path);
      unload();
      return false;
    }

    // printf("[wabc] SceneABC::load() opened: %s\n", path);
    std::vector<std::istream*> streams{ m_stream.get() };
    Alembic::AbcCoreOgawa::ReadArchive archive_reader(streams);
    m_archive = Alembic::Abc::IArchive(archive_reader(path), Alembic::Abc::kWrapExisting, Alembic::Abc::ErrorHandler::kThrowPolicy);
  }
  catch (Alembic::Util::Exception e) {
    // printf("[wabc] SceneABC::load() exception: %s\n", e.what());
    unload();
    return false;
  }

  if (m_archive) {
    m_mono_mesh = std::make_shared<Mesh>();
    m_mono_points = std::make_shared<Points>();

    ImportContext ctx;
    ctx.obj = m_archive.getTop();
    scanNodes(ctx);

    // setup time range + dominant time sampling stats
    m_time_range = { 0.0, 0.0 };
    m_dominant_frame_count = 0;
    m_dominant_fps = 0.0;
    m_dominant_acyclic = false;
    m_dominant_num_cycles = 0;
    uint32_t nt = m_archive.getNumTimeSamplings();
    for (uint32_t ti = 1; ti < nt; ++ti) {
      double time_start = 0.0, time_end = 0.0;

      auto ts = m_archive.getTimeSampling(ti);
      auto tst = ts->getTimeSamplingType();
      uint32_t num_samples = (uint32_t)m_sample_counts[ts.get()];
      uint32_t samples_per_cycle = tst.getNumSamplesPerCycle();
      double time_per_cycle = tst.getTimePerCycle();
      uint32_t num_cycles = num_samples / samples_per_cycle;

      if (tst.isUniform() || tst.isCyclic()) {
        auto start = ts->getStoredTimes()[0];

        if (tst.isUniform()) {
          time_start = start;
          time_end = num_cycles > 0 ? start + (time_per_cycle * (num_cycles - 1)) : start;
        }
        else if (tst.isCyclic()) {
          auto& times = ts->getStoredTimes();
          if (!times.empty()) {
            size_t ntimes = times.size();
            time_start = start + (times.front() - time_per_cycle);
            time_end = start + (times.back() - time_per_cycle) + (time_per_cycle * num_cycles);
          }
        }
      }
      else if (tst.isAcyclic()) {
        auto& s = ts->getStoredTimes();
        if (!s.empty()) {
          time_start = s.front();
          time_end = s.back();
        }
      }

      if (ti == 1) {
        m_time_range = { time_start, time_end };
      }
      else {
        std::get<0>(m_time_range) = std::min(std::get<0>(m_time_range), time_start);
        std::get<1>(m_time_range) = std::max(std::get<1>(m_time_range), time_end);
      }

      // Pick the dominant time sampling (the one with the most samples) so
      // getFps()/getFrameCount() return the longest animation, not whatever
      // a child schema with 1 sample happens to have.
      if (num_samples > m_dominant_frame_count) {
        m_dominant_frame_count = num_samples;
        m_dominant_num_cycles = num_cycles;
        m_dominant_acyclic = tst.isAcyclic();
        if ((tst.isUniform() || tst.isCyclic()) && num_samples > 1 && time_per_cycle > 0.0) {
          double span = time_end - time_start;
          if (span > 0.0) {
            // FPS = total unique frames minus 1, divided by duration in seconds.
            // This matches the spec: time_per_cycle * (num_cycles - 1) == span.
            m_dominant_fps = (double)(num_cycles * samples_per_cycle - 1) / span;
          } else {
            m_dominant_fps = 0.0;
          }
        } else {
          m_dominant_fps = 0.0;
        }
      }
    }
    // printf("[wabc] SceneABC::load() time range: %.3f to %.3f\n",
    //        std::get<0>(m_time_range), std::get<1>(m_time_range));
    // printf("[wabc] SceneABC::load() dominant: %u frames, fps=%.3f, acyclic=%s\n",
    //        m_dominant_frame_count, m_dominant_fps, m_dominant_acyclic ? "yes" : "no");
    return true;
  }
  return false;
}

uint32_t SceneABC::getFrameCount() const
{
  return m_dominant_frame_count;
}

double SceneABC::getFps() const
{
  return m_dominant_fps;
}

void SceneABC::scanNodes(ImportContext ctx)
{
  auto update_sample_count = [this](auto& schema) {
    auto ts = schema.getTimeSampling();
    auto& n = m_sample_counts[ts.get()];
    n = std::max(n, (size_t)schema.getNumSamples());
  };

  auto obj = ctx.obj;
  const auto& metadata = obj.getMetaData();

  if (Alembic::AbcGeom::IXformSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::IXform(obj).getSchema();
    update_sample_count(schema);
  }
  else if (Alembic::AbcGeom::ICameraSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::ICamera(obj).getSchema();
    update_sample_count(schema);
  }
  else if (Alembic::AbcGeom::IPolyMeshSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::IPolyMesh(obj).getSchema();
    update_sample_count(schema);
  }
  else if (Alembic::AbcGeom::IPointsSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::IPoints(obj).getSchema();
    update_sample_count(schema);
  }

  size_t n = obj.getNumChildren();
  for (size_t ci = 0; ci < n; ++ci) {
    ctx.obj = obj.getChild(ci);
    scanNodes(ctx);
  }
}

void SceneABC::seek(double time)
{
  try {
    if (!m_archive || time == m_time) {
      return;
    }

    m_time = time;
    m_mono_mesh->clear();
    m_mono_points->clear();

    ImportContext ctx;
    ctx.obj = m_archive.getTop();
    ctx.time = time;
    seekImpl(ctx);

    m_mono_mesh->upload();
    m_mono_points->upload();
  }
  catch (std::exception& e) {
    // printf("[wabc] seek() exception: %s\n", e.what());
  }
  catch (...) {
    // printf("[wabc] seek() unknown exception\n");
  }
}

void SceneABC::seekImpl(ImportContext ctx)
{
  auto obj = ctx.obj;
  auto ss = Alembic::Abc::ISampleSelector(ctx.time);

  const auto& metadata = obj.getMetaData();

if (Alembic::AbcGeom::IXformSchema::matches(metadata)) {
      auto schema = Alembic::AbcGeom::IXform(obj).getSchema();
      Alembic::AbcGeom::XformSample sample;
      schema.get(sample, ss);
      auto m = sample.getMatrix();
      ctx.local_matrix.assign((double4x4&)m);
      ctx.global_matrix = ctx.local_matrix * ctx.global_matrix;
    }
  else if (Alembic::AbcGeom::ICameraSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::ICamera(obj).getSchema();
    Alembic::AbcGeom::CameraSample sample;
    schema.get(sample, ss);

    auto& dst = m_camera_table[obj.getFullName()];
    if (dst) {
      dst->m_position = extract_position(ctx.global_matrix);
      dst->m_direction = normalize(mul_v(ctx.global_matrix, float3{ 0.0f, 0.0f, -1.0f }));
      dst->m_up = normalize(mul_v(ctx.global_matrix, float3{ 0.0f, 1.0f, 0.0f }));

      dst->m_focal_length = (float)sample.getFocalLength();
      dst->m_aperture = float2{
        (float)sample.getHorizontalAperture(),
        (float)sample.getVerticalAperture()
      } * 10.0f;
      dst->m_lens_shift = float2{
        (float)(sample.getHorizontalFilmOffset() / sample.getHorizontalAperture()),
        (float)(sample.getVerticalFilmOffset() / sample.getVerticalAperture())
      };
      dst->m_near = std::max((float)sample.getNearClippingPlane(), 0.01f);
      dst->m_far = std::max((float)sample.getFarClippingPlane(), dst->m_near);
    }
  }
else if (Alembic::AbcGeom::IPolyMeshSchema::matches(metadata)) {
      auto schema = Alembic::AbcGeom::IPolyMesh(obj).getSchema();
      Alembic::AbcGeom::IPolyMeshSchema::Sample sample;
      schema.get(sample, ss);

      auto counts_sample = sample.getFaceCounts();
      auto indices_sample = sample.getFaceIndices();
      auto points_sample = sample.getPositions();

      int num_faces = (int)counts_sample->size();
      int num_indices = (int)indices_sample->size();
      int num_points = (int)points_sample->size();
      int index_offset = (int)m_mono_mesh->m_points.size();

      const int32_t* counts_ptr = counts_sample->get();
      const int32_t* indices_ptr = indices_sample->get();
      const auto* points_ptr = points_sample->get();

      // Per-polyMesh log disabled (was spamming every frame via stdout → WASM → DevTools).
      // The summary can be re-enabled temporarily for debugging mesh layout.
      // printf("[wabc] IPolyMesh %s: verts=%d, faces=%d, indices=%d (running_total=%zu)\n",
      //        obj.getFullName().c_str(), num_points, num_faces, num_indices,
      //        m_mono_mesh->m_points.size());

      // 1. Append transformed indexed positions into m_mono_mesh->m_points
      float3* dst_points = expand(m_mono_mesh->m_points, num_points);
      int nan_count = 0;
      float maxAbs = 0.0f;
      for (int i = 0; i < num_points; ++i) {
        float3 p = { points_ptr[i].x, points_ptr[i].y, points_ptr[i].z };
        float3 t = mul_p(ctx.global_matrix, p);
        dst_points[i] = t;
        // Detect anomalies: NaN/Inf or absurdly large coordinates (off by 10x of expected bbox)
        if (!std::isfinite(t.x) || !std::isfinite(t.y) || !std::isfinite(t.z)) {
          nan_count++;
        } else {
          float ax = std::abs(t.x), ay = std::abs(t.y), az = std::abs(t.z);
          float m = std::max({ax, ay, az});
          if (m > maxAbs) maxAbs = m;
        }
      }
      if (nan_count > 0 || maxAbs > 1000.0f) {
        // printf("[wabc]   WARN %s: nan/inf=%d, maxAbsCoord=%.2f\n",
        //        obj.getFullName().c_str(), nan_count, maxAbs);
      }

      // 2. Append raw (untransformed) indexed positions into m_raw_points
      //    (matches i-saint: same array later gets expanded triangles appended)
      float3* dst_raw_points = expand(m_mono_mesh->m_raw_points, num_points);
      for (int i = 0; i < num_points; ++i) {
        dst_raw_points[i] = { points_ptr[i].x, points_ptr[i].y, points_ptr[i].z };
      }

      // 3. Count primitives
      int num_lines = 0;
      int num_triangles = 0;
      for (int i = 0; i < num_faces; ++i) {
        int c = (int)counts_ptr[i];
        if (c == 2) {
          num_lines += 1;
        }
        else if (c >= 3) {
          num_triangles += c - 2;
          num_lines += c;
        }
      }

      // 4. Allocate expanded buffers.
      //    IMPORTANT: m_raw_points_ex is appended into the SAME m_raw_points array
      //    (i-saint pattern). The first num_points entries are indexed raw positions;
      //    the next num_triangles*3 entries are expanded raw positions.
      const float3* src_points = dst_points;
      int* dst_counts = expand(m_mono_mesh->m_counts, num_faces);
      int* dst_findices = expand(m_mono_mesh->m_face_indices, num_indices);
      int* dst_windices = expand(m_mono_mesh->m_wireframe_indices, num_lines * 2);
      float3* dst_points_ex = expand(m_mono_mesh->m_points_ex, num_triangles * 3);
      float3* dst_raw_points_ex = expand(m_mono_mesh->m_raw_points, num_triangles * 3);

      // 5. Copy counts
      for (int i = 0; i < num_faces; ++i)
        dst_counts[i] = (int)counts_ptr[i];

      // 6. Copy face indices with offset (i-saint: src_indices[i] + index_offset)
      for (int i = 0; i < num_indices; ++i)
        dst_findices[i] = (int)indices_ptr[i] + index_offset;

      // 7. Walk faces and emit triangles + wireframe.
      //    Use local src_indices pointer advance (i-saint style), NOT sequential counter.
      const int* src_indices = indices_ptr;
      for (int i = 0; i < num_faces; ++i) {
        int c = (int)counts_ptr[i];
        if (c == 2) {
          *dst_windices++ = src_indices[0] + index_offset;
          *dst_windices++ = src_indices[1] + index_offset;
        }
        else if (c > 2) {
          // wireframe edges: (src_indices[fi], src_indices[(fi+1)%c])
          for (int fi = 0; fi < c; ++fi) {
            *dst_windices++ = src_indices[fi] + index_offset;
            *dst_windices++ = (fi == c - 1 ? src_indices[0] : src_indices[fi + 1]) + index_offset;
          }
          // triangle fan from src_indices[0]
          for (int fi = 0; fi < c - 2; ++fi) {
            int i0 = src_indices[0];
            int i1 = src_indices[1 + fi];
            int i2 = src_indices[2 + fi];
            *dst_points_ex++ = src_points[i0];
            *dst_points_ex++ = src_points[i1];
            *dst_points_ex++ = src_points[i2];
            // untransformed copies for bbox consistency
            *dst_raw_points_ex++ = { points_ptr[i0].x, points_ptr[i0].y, points_ptr[i0].z };
            *dst_raw_points_ex++ = { points_ptr[i1].x, points_ptr[i1].y, points_ptr[i1].z };
            *dst_raw_points_ex++ = { points_ptr[i2].x, points_ptr[i2].y, points_ptr[i2].z };
          }
        }
        src_indices += c;
      }
    }
  else if (Alembic::AbcGeom::IPointsSchema::matches(metadata)) {
    auto schema = Alembic::AbcGeom::IPoints(obj).getSchema();
    Alembic::AbcGeom::IPointsSchema::Sample sample;
    schema.get(sample, ss);

    auto points_sample = sample.getPositions();
    size_t num_pts = points_sample->size();

    float3* points = expand(m_mono_points->m_points, num_pts);
    const auto* points_ptr = points_sample->get();
    for (size_t i = 0; i < num_pts; ++i) {
      float3 p = { points_ptr[i].x, points_ptr[i].y, points_ptr[i].z };
      points[i] = mul_p(ctx.global_matrix, p);
    }
  }

  size_t n = obj.getNumChildren();
  for (size_t ci = 0; ci < n; ++ci) {
    ctx.obj = obj.getChild(ci);
    seekImpl(ctx);
  }
}

IScene* CreateSceneABC_()
{
  return new SceneABC();
}

} // namespace wabc
