// SmallFBX.h - Minimal FBX type stubs for wabc
// Only provides the sfbx namespace types used by wabc.h interfaces.
// Full FBX support is NOT included (SceneFBX.cpp is excluded).

#pragma once

#include <vector>
#include <cstring>

namespace sfbx {

// Matches std::span behavior (C++20). Default to void for raw byte access.
template<class T = void>
class span {
public:
  using value_type = T;
  using size_type = size_t;
  using iterator = T*;
  span() : m_data(nullptr), m_size(0) {}
  span(T* data, size_t size) : m_data(data), m_size(size) {}
  span(const T* data, size_t size) : m_data(const_cast<T*>(data)), m_size(size) {}
  T* data() const { return m_data; }
  size_t size() const { return m_size; }
  size_t size_bytes() const { return m_size * sizeof(T); }
  T& operator[](size_t i) const { return m_data[i]; }
  T* begin() const { return m_data; }
  T* end() const { return m_data + m_size; }
private:
  T* m_data;
  size_t m_size;
};

template<class T>
span<T> make_span(T* data, size_t size) { return span<T>(data, size); }

template<class T>
class RawVector {
public:
  void clear() { m_data.clear(); m_capacity = 0; }
  void resize(size_t n) { m_data.resize(n); m_capacity = n; }
  template<class U> void push_back(const U& v) { m_data.push_back(v); }
  template<class U, class... Args> void emplace_back(Args&&... args) {
    m_data.emplace_back(std::forward<Args>(args)...);
  }
  T* data() { return m_data.data(); }
  const T* data() const { return m_data.data(); }
  size_t size() const { return m_data.size(); }
  size_t capacity() const { return m_capacity; }
  T& operator[](size_t i) { return m_data[i]; }
  const T& operator[](size_t i) const { return m_data[i]; }
private:
  std::vector<T> m_data;
  size_t m_capacity = 0;
};

} // namespace sfbx
