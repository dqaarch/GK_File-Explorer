// alembic_glue.cpp - Emscripten C ABI wrapper for the Alembic SDK.
//
// Phase 1 surface — geometry + transform sampling ONLY. Normals + UVs are
// intentionally omitted from this iteration; they add substantial include
// surface (AbcGeom::IGeomParam, etc.) for very little JS-side use. They
// can be added in a follow-up without changing the entry-point names.
//
// Entry points:
//   abc_open_buffer(data, size)        -> int handle (>0) or 0 on error
//   abc_close(handle)                  -> void
//   abc_list_objects(handle, buf, cap) -> int n bytes written, -1 on err
//
//   abc_get_metadata(handle, path, outBuf, cap)
//       Writes "<type>\t<minTime>\t<maxTime>\t<sampleCount>" into outBuf.
//
//   abc_sample_mesh(handle, path, t,
//                   outPos, posCap, outVertexCount,
//                   outIdx, idxCap, outFaceCount,
//                   topologyChanged) -> 1 ok | 0 err
//
//   abc_get_camera_transforms(handle, path,
//                             outMatrix16, numSamples,
//                             timesArray) -> int n frames written | 0 | -1

#include <Alembic/AbcCoreFactory/IFactory.h>
#include <Alembic/Abc/IArchive.h>
#include <Alembic/Abc/IObject.h>
#include <Alembic/Abc/ISampleSelector.h>
#include <Alembic/AbcGeom/IPolyMesh.h>
#include <Alembic/AbcGeom/IXform.h>
#include <emscripten/emscripten.h>

#include <exception>
#include <cstring>
#include <ios>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

// Minimal unbuffered streambuf wrapping an in-memory byte range.
// Alembic's IStreams calls std::streambuf::sgetn() / uflow() for reading and
// seekoff(0,end) to find the stream size. We override all three so that:
//   - Reads return data from the current position.
//   - seekoff(0, end) sets the current position to the end without corrupting
//     the buffer's get-area state, so subsequent reads still work.
class MemIStreamBuf : public std::streambuf {
public:
  MemIStreamBuf(const char* d, std::streamsize n)
    : data_(d), size_(n), pos_(0) {
    EM_ASM({ console.log('[MemIStreamBuf] ctor data=' + $0 + ' size=' + $1); },
      (int)(uintptr_t)d, (int)n);
    char* p = const_cast<char*>(d);
    this->setg(p, p, p + n);  // initial get area
  }

  // ── Reading ──────────────────────────────────────────────────────────────
  // xsgetn is the virtual method that std::streambuf::sgetn() calls internally.
  // Override it to read from our custom buffer.
  std::streamsize xsgetn(char* out, std::streamsize n) override {
    std::streamsize avail = size_ - pos_;
    if (avail <= 0) {
      EM_ASM({ console.error('[MemIStreamBuf] sgetn: at end, pos=' + $0 + ' size=' + $1); },
        (int)pos_, (int)size_);
      return 0;
    }
    std::streamsize to_copy = std::min(avail, n);
    std::memcpy(out, data_ + pos_, to_copy);
    pos_ += to_copy;
    EM_ASM({ console.log('[MemIStreamBuf] sgetn: copied=' + $0 + ' pos=' + $1); },
      (int)to_copy, (int)pos_);
    return to_copy;
  }

  // uflow is called by std::istream::get() — must advance get pointer by 1.
  int_type uflow() override {
    if (pos_ >= size_) return traits_type::eof();
    return traits_type::to_int_type(data_[pos_++]);
  }

  // underflow is called by std::istream::peek() — must return char or EOF.
  int_type underflow() override {
    if (pos_ >= size_) return traits_type::eof();
    return traits_type::to_int_type(
      data_[pos_]
    );
  }

  // ── Seeking ─────────────────────────────────────────────────────────────
  pos_type seekoff(off_type off, std::ios_base::seekdir dir,
                   std::ios_base::openmode which = std::ios_base::in) override {
    if (!(which & std::ios_base::in)) return pos_type(off_type(-1));

    off_type new_pos = 0;
    switch (dir) {
      case std::ios_base::beg: new_pos = off;              break;
      case std::ios_base::cur:  new_pos = pos_ + off;      break;
      case std::ios_base::end:  new_pos = size_ + off;    break;
      default:                  return pos_type(off_type(-1));
    }
    if (new_pos < 0 || new_pos > size_) {
      EM_ASM({ console.error('[MemIStreamBuf] seekoff: bad pos=' + $0 + ' size=' + $1); },
        (int)new_pos, (int)size_);
      return pos_type(off_type(-1));
    }

    pos_ = static_cast<std::streamsize>(new_pos);
    char* p = const_cast<char*>(data_);
    setg(p, p + pos_, p + size_);  // restore get area from data_
    EM_ASM({ console.log('[MemIStreamBuf] seekoff: new_pos=' + $0); }, (int)pos_);
    return pos_type(pos_);
  }

  pos_type seekpos(pos_type pos,
                   std::ios_base::openmode which = std::ios_base::in) override {
    return seekoff(off_type(pos), std::ios_base::beg, which);
  }

private:
  const char* const data_;
  const std::streamsize size_;
  std::streamsize pos_;   // current read position
};

using Alembic::AbcCoreFactory::IFactory;
using Alembic::Abc::IArchive;
using Alembic::Abc::IObject;
using Alembic::Abc::TimeSamplingPtr;
using Alembic::Abc::ISampleSelector;
using Alembic::AbcGeom::IPolyMesh;
using Alembic::AbcGeom::IPolyMeshSchema;
using Alembic::AbcGeom::IXform;
using Alembic::AbcGeom::IXformSchema;

struct Session {
  IArchive arch;  // Abc's IArchive is a ref-counted handle.
  std::string error;
};

// Session registry keyed by int handle. JS holds the handle.
std::map<int, std::unique_ptr<Session>> g_sessions;
int g_next_handle = 1;

inline Session* get_session(int h) {
  auto it = g_sessions.find(h);
  return it != g_sessions.end() ? it->second.get() : nullptr;
}

// Walk the IObject tree and invoke `visit(fullPath, obj)` for every node.
template <typename Fn>
void walk(IObject top, const std::string& parentPath, Fn visit) {
  visit(parentPath, top);
  for (size_t i = 0; i < top.getNumChildren(); ++i) {
    IObject child = top.getChild(i);
    std::string childPath = parentPath + "/" + child.getName();
    walk(child, childPath, visit);
  }
}

// Descend by /-separated path (skipping leading '/'). Returns invalid IObject
// if any segment is missing.
IObject resolve_path(IObject root, const char* path) {
  std::string p(path ? path : "");
  size_t start = (!p.empty() && p[0] == '/') ? 1 : 0;
  IObject obj = root;
  while (start < p.size()) {
    size_t slash = p.find('/', start);
    std::string name = p.substr(start, slash - start);
    if (name.empty()) break;
    IObject child = obj.getChild(name);
    if (!child.valid()) return IObject();
    obj = child;
    start = (slash == std::string::npos) ? p.size() : slash + 1;
  }
  return obj;
}

} // namespace

extern "C" {

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

int abc_open_buffer(const char* data, int size) {
  // Debug: log received buffer info to browser console
  EM_ASM({
    console.log('[Alembic] abc_open_buffer called, data=' + $0 + ' size=' + $1);
  }, (int)(uintptr_t)data, size);
  if (!data || size <= 0) return 0;
  IFactory factory;
  factory.setPolicy(Alembic::Abc::ErrorHandler::kNoisyNoopPolicy);
  // Binary buffer → custom streambuf → istream (no char* conversion, preserves NUL).
  MemIStreamBuf membuf(data, static_cast<std::streamsize>(size));
  std::istream stream(&membuf);
  std::vector<std::istream*> streams{&stream};
  IFactory::CoreType ctype = IFactory::kUnknown;
  IArchive arch;
  try {
    arch = factory.getArchive(streams, ctype);
  } catch (std::exception& e) {
    EM_ASM({ console.error('[Alembic] getArchive exception: ' + UTF8ToString($0)); }, e.what());
    return 0;
  } catch (...) {
    EM_ASM({ console.error('[Alembic] getArchive unknown exception'); });
    return 0;
  }
  if (!arch.valid()) return 0;

  int h = g_next_handle++;
  auto s = std::make_unique<Session>();
  s->arch = arch;
  g_sessions[h] = std::move(s);
  return h;
}

void abc_close(int h) { g_sessions.erase(h); }

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

int abc_list_objects(int h, char* buf, int cap) {
  Session* s = get_session(h);
  if (!s || !buf || cap <= 0) return -1;
  EM_ASM({ console.log('[Alembic] abc_list_objects handle=' + $0); }, h);
  try {
    IObject top = s->arch.getTop();
    std::string out;
    walk(top, std::string("/"), [&](const std::string& path, IObject) {
      out += path;
      out += '\n';
    });
    if (static_cast<int>(out.size()) >= cap) {
      int cut = cap - 1;
      while (cut > 0 && out[cut - 1] != '\n') --cut;
      out.resize(cut);
    }
    std::memcpy(buf, out.data(), out.size());
    buf[out.size()] = '\0';
    EM_ASM({ console.log('[Alembic] abc_list_objects returned ' + $0 + ' bytes'); }, (int)out.size());
    return static_cast<int>(out.size());
  } catch (std::exception& e) {
    EM_ASM({ console.error('[Alembic] abc_list_objects exception: ' + UTF8ToString($0)); }, e.what());
    return -1;
  } catch (...) {
    EM_ASM({ console.error('[Alembic] abc_list_objects unknown exception'); });
    return -1;
  }
}

int abc_get_metadata(int h, const char* path, char* buf, int cap) {
  Session* s = get_session(h);
  if (!s || !path || !buf || cap <= 0) return -1;
  IObject obj = resolve_path(s->arch.getTop(), path);
  if (!obj.valid()) return -1;

  std::string type = "unknown";
  double minT = 0.0, maxT = 0.0;
  size_t samples = 0;
  TimeSamplingPtr ts;

  if (IPolyMesh::matches(obj.getHeader())) {
    type = "mesh";
    IPolyMeshSchema schema = IPolyMesh(obj).getSchema();
    ts = schema.getTimeSampling();
    samples = schema.getNumSamples();
  } else if (IXform::matches(obj.getHeader())) {
    type = "xform";
    IXformSchema schema = IXform(obj).getSchema();
    ts = schema.getTimeSampling();
    samples = schema.getNumSamples();
  }
  if (ts && samples > 0) {
    minT = ts->getSampleTime(0);
    maxT = ts->getSampleTime(samples - 1);
  }

  char out[256];
  std::snprintf(out, sizeof(out), "%s\t%.6f\t%.6f\t%zu", type.c_str(), minT, maxT, samples);
  int len = static_cast<int>(std::strlen(out)) + 1;
  if (len > cap) len = cap;
  std::memcpy(buf, out, len);
  return len;
}

// ---------------------------------------------------------------------------
// Mesh sampling
// ---------------------------------------------------------------------------

int abc_sample_mesh(int h,
                    const char* path,
                    double t,
                    float* outPos, int posCap, int* outVertexCount,
                    uint32_t* outIdx, int idxCap, int* outFaceCount,
                    int* topologyChanged) {
  Session* s = get_session(h);
  if (!s || !path) return 0;
  IObject obj = resolve_path(s->arch.getTop(), path);
  if (!obj.valid()) return 0;
  if (!IPolyMesh::matches(obj.getHeader())) return 0;

  IPolyMeshSchema schema = IPolyMesh(obj).getSchema();
  TimeSamplingPtr tsp = schema.getTimeSampling();
  size_t numSamples = schema.getNumSamples();
  if (!tsp || numSamples == 0) return 0;

  // Pick the sample nearest to time `t`.
  Alembic::Abc::index_t sampleIdx = 0;
  double bestDt = 1e30;
  for (size_t i = 0; i < numSamples; ++i) {
    double dt = std::abs(tsp->getSampleTime(i) - t);
    if (dt < bestDt) { bestDt = dt; sampleIdx = static_cast<Alembic::Abc::index_t>(i); }
  }
  ISampleSelector sel(sampleIdx);

  IPolyMeshSchema::Sample samp;
  try {
    samp = schema.getValue(sel);
  } catch (...) {
    return 0;
  }

  // TypedArraySample accessors return smart-pointer-like handles; deref + []
  // yields the typed element.
  Alembic::Abc::P3fArraySamplePtr Pptr      = samp.getPositions();
  Alembic::Abc::Int32ArraySamplePtr countsP = samp.getFaceCounts();
  Alembic::Abc::Int32ArraySamplePtr idxP  = samp.getFaceIndices();

  size_t vCount = Pptr       ? Pptr->size()      : 0;
  size_t fCount = countsP    ? countsP->size()   : 0;
  size_t idxCountIn = idxP   ? idxP->size()      : 0;

  // Triangulate via fan triangulation; sum (counts[i]-2) over all faces.
  Alembic::Abc::Int32ArraySample &counts = *countsP;
  size_t triCount = 0;
  for (size_t f = 0; f < fCount; ++f) {
    Alembic::Abc::int32_t c = counts[f];
    if (c >= 3) triCount += static_cast<size_t>(c - 2);
  }
  size_t triIdxCount = triCount * 3;

  if (outVertexCount) *outVertexCount = static_cast<int>(vCount);
  if (outFaceCount)   *outFaceCount   = static_cast<int>(triCount);
  if (topologyChanged) *topologyChanged = 0;

  // Capacity guards.
  if (static_cast<int>(vCount * 3) > posCap) return 0;
  if (static_cast<int>(triIdxCount) > idxCap) return 0;
  (void)idxCountIn;

  // Write vertex positions.
  Alembic::Abc::P3fArraySample &Ptyped = *Pptr;
  for (size_t i = 0; i < vCount; ++i) {
    const Alembic::Abc::V3f &p = Ptyped[i];
    outPos[i * 3 + 0] = p.x;
    outPos[i * 3 + 1] = p.y;
    outPos[i * 3 + 2] = p.z;
  }

  // Triangulate (fan) and write indices. We do not actually copy the .abc
  // face indices — Alembic already gave us per-vertex face-id, but the
  // GL convention wants triangle indices. The fan pattern for an N-gon is
  // (base, base+k, base+k+1) for k=1..N-2.
  size_t cursor = 0;
  size_t baseVertex = 0;
  for (size_t f = 0; f < fCount; ++f) {
    Alembic::Abc::int32_t c = counts[f];
    if (c >= 3) {
      for (Alembic::Abc::int32_t k = 1; k + 1 < c; ++k) {
        outIdx[cursor++] = static_cast<uint32_t>(baseVertex + 0);
        outIdx[cursor++] = static_cast<uint32_t>(baseVertex + k);
        outIdx[cursor++] = static_cast<uint32_t>(baseVertex + k + 1);
      }
    }
    baseVertex += static_cast<size_t>(c);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Camera / xform transforms
// ---------------------------------------------------------------------------

int abc_get_camera_transforms(int h,
                              const char* path,
                              float* outMatrix16,
                              int numSamples,
                              const double* timesArray) {
  Session* s = get_session(h);
  if (!s || !path || !outMatrix16 || numSamples <= 0 || !timesArray) return -1;
  IObject obj = resolve_path(s->arch.getTop(), path);
  if (!obj.valid()) return 0;
  if (!IXform::matches(obj.getHeader())) return 0;

  IXformSchema schema = IXform(obj).getSchema();
  size_t totalSamples = schema.getNumSamples();
  TimeSamplingPtr tsp = schema.getTimeSampling();
  if (!tsp || totalSamples == 0) return 0;

  for (int i = 0; i < numSamples; ++i) {
    double t = timesArray[i];
    Alembic::Abc::index_t sampleIdx = 0;
    double bestDt = 1e30;
    for (size_t s2 = 0; s2 < totalSamples; ++s2) {
      double dt = std::abs(tsp->getSampleTime(s2) - t);
      if (dt < bestDt) { bestDt = dt; sampleIdx = static_cast<Alembic::Abc::index_t>(s2); }
    }
    ISampleSelector sel(sampleIdx);
    try {
      Alembic::Abc::M44d m = schema.getValue(sel).getMatrix();
      // Alembic M44d is double[4][4] in row-major order; GL wants column-major.
      for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 4; ++c) {
          outMatrix16[i * 16 + c * 4 + r] = static_cast<float>(m[r][c]);
        }
      }
    } catch (...) {
      // Write identity on failure so JS still sees a continuous track.
      for (int k = 0; k < 16; ++k) {
        outMatrix16[i * 16 + k] = (k % 5 == 0) ? 1.0f : 0.0f;
      }
    }
  }
  return numSamples;
}

} // extern "C"
