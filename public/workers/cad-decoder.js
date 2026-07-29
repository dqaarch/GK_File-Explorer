// CAD Decoder Web Worker (Module Worker)
// Handles STEP/IGES decoding off the main thread

let occt = null;

async function initOCCT(wasmBuffer) {
  if (occt) return { success: true };

  try {
    const module = await import("occt-import-js");
    occt = await module.default({ wasmBinary: wasmBuffer });
    self.postMessage({ type: "init", success: true });
    return { success: true };
  } catch (err) {
    self.postMessage({ type: "init", success: false, error: err?.message || String(err) });
    return { success: false, error: err?.message };
  }
}

self.onmessage = async function(e) {
  const { type, wasmBuffer, id, buffer, format } = e.data;

  if (type === "init") {
    await initOCCT(wasmBuffer);
    return;
  }

  if (type === "decode") {
    if (!occt) {
      self.postMessage({ type: "error", id, error: "WASM not initialized" });
      return;
    }

    try {
      self.postMessage({ type: "progress", id, percent: 10 });

      let result;
      const data = new Uint8Array(buffer);

      if (format === "step" || format === "stp") {
        result = occt.ReadStepFile(data, {
          linearDeflection: 0.001,
          angularDeflection: 0.5,
        });
      } else if (format === "iges" || format === "igs") {
        result = occt.ReadIgesFile(data, {
          linearDeflection: 0.001,
          angularDeflection: 0.5,
        });
      }

      self.postMessage({ type: "progress", id, percent: 90 });
      self.postMessage({ type: "result", id, result });
    } catch (err) {
      self.postMessage({ type: "error", id, error: err?.message || String(err) });
    }
  }
};