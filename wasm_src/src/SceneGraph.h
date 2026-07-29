// SceneGraph.h - Scene graph types for wabc WASM
// Clean version without GLFW dependencies

#pragma once
#include "SmallFBX.h"
#include "VectorMath.h"
#include <string>
#include <vector>
#include <memory>
#include <cstring>

namespace wabc {

using sfbx::make_span;
using sfbx::RawVector;
using sfbx::span;

class IEntity
{
public:
  virtual ~IEntity() {}
};

class ICamera : public IEntity
{
public:
  virtual const std::string& getPath() const = 0;
  virtual float3 getPosition() const = 0;
  virtual float3 getDirection() const = 0;
  virtual float3 getUp() const = 0;
  virtual float getFocalLength() const = 0;
  virtual float2 getAperture() const = 0;
  virtual float2 getLensShift() const = 0;
  virtual float getNearPlane() const = 0;
  virtual float getFarPlane() const = 0;
};

struct JointWeight
{
  int index{};
  float weight{};
};

class ISkin : public IEntity
{
public:
  virtual span<int> getJointCounts() const = 0;
  virtual span<JointWeight> getJointWeights() const = 0;
  virtual span<float4x4> getJointMatrices() const = 0;
  virtual bool deformPoints(span<float3> dst, span<float3> src) const = 0;
  virtual bool deformNormals(span<float3> dst, span<float3> src) const = 0;
};

class IBlendShape : public IEntity
{
public:
  virtual span<int> getIndices() const = 0;
  virtual span<float3> getDeltaPoints() const = 0;
  virtual span<float3> getDeltaNormals() const = 0;
  virtual bool deformPoints(span<float3> dst, span<float3> src, float w) const = 0;
  virtual bool deformNormals(span<float3> dst, span<float3> src, float w) const = 0;
};

class IMesh : public IEntity
{
public:
  virtual span<float> getPoints() const = 0;
  virtual span<float> getNormals() const = 0;
  virtual span<float> getPointsEx() const = 0;
  virtual span<float> getNormalsEx() const = 0;
  virtual span<float> getRawPoints() const = 0; // untransformed expanded positions
  virtual span<int> getCounts() const = 0;
  virtual span<int> getFaceIndices() const = 0;
  virtual span<int> getWireframeIndices() const = 0;
};

class IPoints : public IEntity
{
public:
  virtual span<float> getPoints() const = 0;
};

// Scene - top-level Alembic reader
class IScene
{
public:
  virtual ~IScene() {}
  virtual void release() = 0;
  virtual bool load(const char* path) = 0;
  virtual bool loadAdditive(const char* path) = 0;
  virtual void unload() = 0;
  virtual std::tuple<double, double> getTimeRange() const = 0;
  /**
   * Total sample count of the dominant time sampling. 0 when the archive has
   * no animation. Used by the JS UI to display frame count without
   * re-walking every Alembic time sampling.
   */
  virtual uint32_t getFrameCount() const = 0;
  /**
   * Frame rate (frames per second) derived from the dominant time sampling.
   * Returns 0.0 for acyclic / unknown sampling. JS UI should fall back to a
   * display-only "No Data" badge in that case.
   */
  virtual double getFps() const = 0;
  virtual void seek(double time) = 0;
  virtual double getTime() const = 0;
  virtual IMesh* getMesh() = 0;
  virtual IPoints* getPoints() = 0;
  virtual span<ICamera*> getCameras() = 0;
};

class Camera : public ICamera
{
public:
  const std::string& getPath() const override { return m_path; }
  float3 getPosition() const override { return m_position; }
  float3 getDirection() const override { return m_direction; }
  float3 getUp() const override { return m_up; }
  float getFocalLength() const override { return m_focal_length; }
  float2 getAperture() const override { return m_aperture; }
  float2 getLensShift() const override { return m_lens_shift; }
  float getNearPlane() const override { return m_near; }
  float getFarPlane() const override { return m_far; }

public:
  std::string m_path;
  float3 m_position{};
  float3 m_direction{ 0.0f, 0.0f, 1.0f };
  float3 m_up{ 0.0f, 1.0f, 0.0f };
  float m_focal_length = 30.0f;
  float2 m_aperture{ 36.0f, 24.0f };
  float2 m_lens_shift{};
  float m_near = 0.01f;
  float m_far = 100.0f;
};
using CameraPtr = std::shared_ptr<Camera>;


class BlendShape : public IBlendShape
{
public:
  span<int> getIndices() const override { return span<int>(m_indices.data(), m_indices.size()); }
  span<float3> getDeltaPoints() const override { return span<float3>((float3*)m_delta_points.data(), m_delta_points.size()); }
  span<float3> getDeltaNormals() const override { return span<float3>((float3*)m_delta_normals.data(), m_delta_normals.size()); }
  bool deformPoints(span<float3> dst, span<float3> src, float w) const override;
  bool deformNormals(span<float3> dst, span<float3> src, float w) const override;

public:
  RawVector<int> m_indices;
  RawVector<float3> m_delta_points;
  RawVector<float3> m_delta_normals;
};
using BlendShapePtr = std::shared_ptr<BlendShape>;


class Skin : public ISkin
{
public:
  span<int> getJointCounts() const override { return span<int>(m_counts.data(), m_counts.size()); }
  span<JointWeight> getJointWeights() const override { return span<JointWeight>((JointWeight*)m_weights.data(), m_weights.size()); }
  span<float4x4> getJointMatrices() const override { return span<float4x4>((float4x4*)m_matrices.data(), m_matrices.size()); }
  bool deformPoints(span<float3> dst, span<float3> src) const override;
  bool deformNormals(span<float3> dst, span<float3> src) const override;

public:
  RawVector<int> m_counts;
  RawVector<JointWeight> m_weights;
  RawVector<float4x4> m_matrices;
};
using SkinPtr = std::shared_ptr<Skin>;


class Mesh : public IMesh
{
public:
  Mesh();
  ~Mesh();
  span<float> getPoints() const override { return span<float>((float*)m_points.data(), m_points.size() * 3); }
  span<float> getNormals() const override { return span<float>((float*)m_normals.data(), m_normals.size() * 3); }
  span<float> getPointsEx() const override { return span<float>((float*)m_points_ex.data(), m_points_ex.size() * 3); }
  span<float> getNormalsEx() const override { return span<float>((float*)m_normals_ex.data(), m_normals_ex.size() * 3); }
  span<float> getRawPoints() const override { return span<float>((float*)m_raw_points.data(), m_raw_points.size() * 3); }
  span<int> getCounts() const override { return span<int>(m_counts.data(), m_counts.size()); }
  span<int> getFaceIndices() const override { return span<int>(m_face_indices.data(), m_face_indices.size()); }
  span<int> getWireframeIndices() const override { return span<int>(m_wireframe_indices.data(), m_wireframe_indices.size()); }

  void clear();
  void upload();

public:
  RawVector<float3> m_points;
  RawVector<float3> m_normals;
  RawVector<float3> m_points_ex;
  RawVector<float3> m_normals_ex;
  RawVector<float3> m_raw_points;  // untransformed positions for bbox calculation

  RawVector<int> m_counts;
  RawVector<int> m_face_indices;
  RawVector<int> m_wireframe_indices;
};
using MeshPtr = std::shared_ptr<Mesh>;


class Points : public IPoints
{
public:
  Points();
  ~Points();
  span<float> getPoints() const override { return span<float>((float*)m_points.data(), m_points.size() * 3); }

  void clear();
  void upload();

public:
  RawVector<float3> m_points;
};
using PointsPtr = std::shared_ptr<Points>;

// Factory function - implemented in SceneABC.cpp
IScene* CreateSceneABC_();

template<class T>
struct releaser { void operator()(T* v) { if (v) v->release(); } };

using IScenePtr = std::shared_ptr<IScene>;
inline IScenePtr CreateSceneABC() {
  return IScenePtr(CreateSceneABC_(), releaser<IScene>());
}

} // namespace wabc
