// SceneGraph.cpp - Scene graph implementation for wabc WASM

#include "SceneGraph.h"
#include "VectorMath.h"

namespace wabc {

bool BlendShape::deformPoints(span<float3> dst, span<float3> src, float w) const
{
  if (dst.data() != src.data())
    memcpy(dst.data(), src.data(), src.size_bytes());

  size_t c = m_indices.size();
  for (size_t i = 0; i < c; ++i)
    dst[m_indices[i]] += m_delta_points[i] * w;
  return true;
}

bool BlendShape::deformNormals(span<float3> dst, span<float3> src, float w) const
{
  if (dst.data() != src.data())
    memcpy(dst.data(), src.data(), src.size_bytes());

  size_t c = m_indices.size();
  for (size_t i = 0; i < c; ++i)
    dst[m_indices[i]] += m_delta_normals[i] * w;
  return true;
}

bool Skin::deformPoints(span<float3> dst, span<float3> src) const
{
  if (m_counts.size() != src.size() || m_counts.size() != dst.size()) {
    return false;
  }

  const JointWeight* weights = (const JointWeight*)m_weights.data();
  size_t nvertices = src.size();
  for (size_t vi = 0; vi < nvertices; ++vi) {
    float3 p = src[vi];
    float3 r{};
    int cjoints = m_counts[vi];
    for (int bi = 0; bi < cjoints; ++bi) {
      JointWeight wgt = weights[bi];
      r += mul_p(m_matrices[wgt.index], p) * wgt.weight;
    }
    dst[vi] = r;
    weights += cjoints;
  }
  return true;
}

bool Skin::deformNormals(span<float3> dst, span<float3> src) const
{
  if (m_counts.size() != src.size() || m_counts.size() != dst.size()) {
    return false;
  }

  const JointWeight* weights = (const JointWeight*)m_weights.data();
  size_t nvertices = src.size();
  for (size_t vi = 0; vi < nvertices; ++vi) {
    float3 p = src[vi];
    float3 r{};
    int cjoints = m_counts[vi];
    for (int bi = 0; bi < cjoints; ++bi) {
      JointWeight wgt = weights[bi];
      r += mul_v(m_matrices[wgt.index], p) * wgt.weight;
    }
    dst[vi] = r;
    weights += cjoints;
  }
  return true;
}

Mesh::Mesh()
{
}

Mesh::~Mesh()
{
}

void Mesh::clear()
{
  m_points.clear();
  m_points_ex.clear();
  m_normals.clear();
  m_normals_ex.clear();
  m_raw_points.clear();
  m_counts.clear();
  m_face_indices.clear();
  m_wireframe_indices.clear();
}

void Mesh::upload()
{
  // No GPU upload needed - data stays in CPU memory
}


Points::Points()
{
}

Points::~Points()
{
}

void Points::clear()
{
  m_points.clear();
}

void Points::upload()
{
  // No GPU upload needed - data stays in CPU memory
}

} // namespace wabc
