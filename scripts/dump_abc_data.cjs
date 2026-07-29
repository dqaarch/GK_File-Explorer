// dump_abc_data.js
// Loads RunningCharacter.abc via wabc.wasm (the same WASM our app uses),
// dumps raw mesh data (positions, expanded verts, face indices) to console.
// Compare this with the diagnostic logs from WabcLoader.ts to verify whether
// our app reads the same data as the underlying wabc library.
//
// Usage:
//   node dump_abc_data.js <path-to-abc-file>
//   node dump_abc_data.js "C:\Users\Mabu02\Downloads\Sample 3D\RunningCharacter.abc"

const fs = require('fs');
const path = require('path');

const WASM_DIR = path.join(__dirname, '..', 'wasm_src', 'build_wabc');
const wasmJsPath = path.join(WASM_DIR, 'wabc.js');

if (!fs.existsSync(wasmJsPath)) {
  console.error(`wabc.js not found at ${wasmJsPath}`);
  process.exit(1);
}

const abcPath = process.argv[2];
if (!abcPath) {
  console.error('Usage: node dump_abc_data.js <path-to-abc-file>');
  process.exit(1);
}
if (!fs.existsSync(abcPath)) {
  console.error(`ABC file not found: ${abcPath}`);
  process.exit(1);
}

console.log(`[DUMP_JS] Loading WASM module from: ${wasmJsPath}`);
console.log(`[DUMP_JS] Loading ABC file: ${abcPath}`);

const abcBytes = fs.readFileSync(abcPath);
console.log(`[DUMP_JS] ABC file size: ${abcBytes.length} bytes`);

// Load emscripten module from wabc.js
// Emscripten modules can be loaded as Promise (modern) or via onRuntimeInitialized (legacy)
const Module = require(wasmJsPath);
if (typeof Module !== 'object') {
  console.error('[DUMP_JS] Module is not an object:', typeof Module);
  process.exit(1);
}

(async () => {
  // Wait for runtime if needed
  if (typeof Module.then === 'function') {
    // Modern emscripten: Module is a Promise
    const m = await Module;
    Object.assign(globalThis, { Module: m });
  } else if (Module.onRuntimeInitialized) {
    // Legacy: attach our handler
    Module.onRuntimeInitialized = () => runDump(Module);
    return;
  }
  await runDump(Module);
})();

async function runDump(Module) {
  if (!Module || !Module.cwrap) {
    console.error('[DUMP_JS] Module not ready: cwrap missing');
    process.exit(1);
  }
  try {
    // Write ABC bytes to wasm FS so wabc_open_buffer can read by path
    const wasmPath = '/input.abc';
    Module.FS.writeFile(wasmPath, abcBytes);

    // Wrap functions
    const wabcOpenBuffer = Module.cwrap('wabc_open_buffer', 'number', ['string']);
    const wabcClose = Module.cwrap('wabc_close', 'number', ['number']);
    const wabcGetStartTime = Module.cwrap('wabc_get_start_time', 'number', ['number']);
    const wabcGetEndTime = Module.cwrap('wabc_get_end_time', 'number', ['number']);
    const wabcSeek = Module.cwrap('wabc_seek', 'number', ['number', 'number']);
    const wabcGetNumVertices = Module.cwrap('wabc_get_num_vertices', 'number', ['number']);
    const wabcGetNumFaces = Module.cwrap('wabc_get_num_faces', 'number', ['number']);
    const wabcGetNumExpandedVertices = Module.cwrap('wabc_get_num_expanded_vertices', 'number', ['number']);
    const wabcGetNumPoints = Module.cwrap('wabc_get_num_points', 'number', ['number']);
    const wabcGetNumCameras = Module.cwrap('wabc_get_num_cameras', 'number', ['number']);

    // Open archive
    console.log('[DUMP_JS] Calling wabc_open_buffer...');
    const handle = wabcOpenBuffer(wasmPath);
    console.log(`[DUMP_JS] Handle = ${handle}`);
    if (handle < 0) {
      console.error('[DUMP_JS] Failed to open archive');
      process.exit(1);
    }

    // Time range
    const t0 = wabcGetStartTime(handle);
    const t1 = wabcGetEndTime(handle);
    console.log(`[DUMP_JS] Time range: [${t0}, ${t1}]`);

    // Counts BEFORE seek (so we can verify hasGeometry flag)
    const indexedVertsBefore = wabcGetNumVertices(handle);
    const indexedFacesBefore = wabcGetNumFaces(handle);
    const expandedBefore = wabcGetNumExpandedVertices(handle);
    const pointsBefore = wabcGetNumPoints(handle);
    const camsBefore = wabcGetNumCameras(handle);
    console.log(`[DUMP_JS] BEFORE seek:`);
    console.log(`  indexedVerts=${indexedVertsBefore}`);
    console.log(`  indexedFaces=${indexedFacesBefore}`);
    console.log(`  expandedVerts=${expandedBefore}`);
    console.log(`  points=${pointsBefore}`);
    console.log(`  cameras=${camsBefore}`);

    // Seek to t0
    console.log(`[DUMP_JS] Calling wabc_seek(${t0})...`);
    const seekResult = wabcSeek(handle, t0);
    console.log(`[DUMP_JS] seek result: ${seekResult}`);

    // Counts AFTER seek
    const indexedVerts = wabcGetNumVertices(handle);
    const indexedFaces = wabcGetNumFaces(handle);
    const expanded = wabcGetNumExpandedVertices(handle);
    console.log(`[DUMP_JS] AFTER seek(0):`);
    console.log(`  indexedVerts=${indexedVerts}`);
    console.log(`  indexedFaces=${indexedFaces}`);
    console.log(`  expandedVerts=${expanded}`);
    console.log(`  ratio (expanded / indexed) = ${(expanded / indexedVerts).toFixed(2)}x`);

    // Read first 18 floats (6 verts) of expanded mesh
    const wabcReadExpandedVertices = Module.cwrap('wabc_read_expanded_vertices', 'number', ['number', 'number', 'number']);
    const maxFloats = expanded * 3;
    const sampleFloats = Math.min(18, maxFloats);
    const posBuf = Module._malloc(sampleFloats * 4);
    wabcReadExpandedVertices(handle, posBuf, sampleFloats);
    console.log(`[DUMP_JS] First 6 expanded frame0 positions:`);
    for (let i = 0; i < 6; i++) {
      const x = Module.getValue(posBuf + i * 12, 'float');
      const y = Module.getValue(posBuf + i * 12 + 4, 'float');
      const z = Module.getValue(posBuf + i * 12 + 8, 'float');
      console.log(`  vert[${i}] X=${x.toFixed(4)} Y=${y.toFixed(4)} Z=${z.toFixed(4)}`);
    }
    Module._free(posBuf);

    // Read FULL expanded mesh and compute stats
    console.log(`[DUMP_JS] Reading full expanded mesh (${expanded * 3} floats, ${(expanded * 3 * 4 / 1024 / 1024).toFixed(1)} MB)...`);
    const fullBuf = Module._malloc(expanded * 3 * 4);
    wabcReadExpandedVertices(handle, fullBuf, expanded * 3);

    let sumX = 0, sumY = 0, sumZ = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let zeroNormalCount = 0;  // we'll compute normals separately

    // Sample 1000 verts for stats
    const sampleStep = Math.max(1, Math.floor(expanded / 1000));
    let sampled = 0;
    for (let i = 0; i < expanded; i += sampleStep) {
      const x = Module.getValue(fullBuf + i * 12, 'float');
      const y = Module.getValue(fullBuf + i * 12 + 4, 'float');
      const z = Module.getValue(fullBuf + i * 12 + 8, 'float');
      sumX += x; sumY += y; sumZ += z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      sampled++;
    }
    console.log(`[DUMP_JS] Sampled ${sampled}/${expanded} verts (step=${sampleStep})`);
    console.log(`[DUMP_JS] Centroid (sampled): X=${(sumX / sampled).toFixed(2)} Y=${(sumY / sampled).toFixed(2)} Z=${(sumZ / sampled).toFixed(2)}`);
    console.log(`[DUMP_JS] BBox (sampled): min=(${minX.toFixed(2)},${minY.toFixed(2)},${minZ.toFixed(2)}) max=(${maxX.toFixed(2)},${maxY.toFixed(2)},${maxZ.toFixed(2)})`);
    console.log(`[DUMP_JS] BBox size: ${(maxX - minX).toFixed(2)}x${(maxY - minY).toFixed(2)}x${(maxZ - minZ).toFixed(2)}`);

    // Compute normals (sample 100 triangles) and count zero-normals
    const normalSample = Math.min(100, Math.floor(expanded / 3));
    const normalStep = Math.max(3, Math.floor(expanded / 3 / normalSample) * 3);
    for (let i = 0; i < expanded - 2; i += normalStep) {
      const v0x = Module.getValue(fullBuf + i * 12, 'float');
      const v0y = Module.getValue(fullBuf + i * 12 + 4, 'float');
      const v0z = Module.getValue(fullBuf + i * 12 + 8, 'float');
      const v1x = Module.getValue(fullBuf + (i + 1) * 12, 'float');
      const v1y = Module.getValue(fullBuf + (i + 1) * 12 + 4, 'float');
      const v1z = Module.getValue(fullBuf + (i + 1) * 12 + 8, 'float');
      const v2x = Module.getValue(fullBuf + (i + 2) * 12, 'float');
      const v2y = Module.getValue(fullBuf + (i + 2) * 12 + 4, 'float');
      const v2z = Module.getValue(fullBuf + (i + 2) * 12 + 8, 'float');

      const ex = v1x - v0x, ey = v1y - v0y, ez = v1z - v0z;
      const fx = v2x - v0x, fy = v2y - v0y, fz = v2z - v0z;
      const nx = ey * fz - ez * fy;
      const ny = ez * fx - ex * fz;
      const nz = ex * fy - ey * fx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-6) zeroNormalCount++;
    }
    console.log(`[DUMP_JS] Zero-normal triangles (sampled ${normalSample}): ${zeroNormalCount}`);

    Module._free(fullBuf);

    // Cleanup
    wabcClose(handle);
    console.log('[DUMP_JS] Done. Compare this output with what the app logs.');
  } catch (e) {
    console.error('[DUMP_JS] Error:', e);
    process.exit(1);
  }
}