#pragma once

// Debug info structure for matrix export
struct MatrixDebugInfo {
  char path[512];
  float matrix[16];  // row-major
  int numVerts;
};

extern MatrixDebugInfo g_debugInfos[32];
extern int g_debugInfoCount;
extern int g_enableDebug;
