// DRACO Worker — bundled as a real file (not a blob URL) because Tauri's
// WebView fails to parse the Emscripten-generated Worker blob that
// DRACOLoader builds by default (`SyntaxError: Unexpected token ':'` at
// 2:9). We importScripts the JS decoder and re-implement the message
// protocol from `DRACOWorker` so the loader stays protocol-compatible.
//
// This file is served from /draco/dracoWorker.js during development and
// from the same path in the production build (Vite copies everything in
// `public/`). The patched DRACOLoader setup in 3DModelViewer.tsx points
// `workerSourceURL` here instead of the blob URL.

importScripts("./draco_decoder.js");

let decoderConfig;
let decoderPending;

onmessage = function (e) {
  const message = e.data;
  switch (message.type) {
    case "init":
      decoderConfig = message.decoderConfig;
      decoderPending = new Promise(function (resolve) {
        decoderConfig.onModuleLoaded = function (draco) {
          resolve({ draco: draco });
        };
        // DracoDecoderModule global is provided by draco_decoder.js above.
        self.DracoDecoderModule(decoderConfig);
      });
      break;
    case "decode": {
      const buffer = message.buffer;
      const taskConfig = message.taskConfig;
      decoderPending.then(function (module) {
        const draco = module.draco;
        const decoder = new draco.Decoder();
        try {
          const geometry = decodeGeometry(
            draco,
            decoder,
            new Int8Array(buffer),
            taskConfig,
          );
          const buffers = geometry.attributes.map(function (attr) {
            return attr.array.buffer;
          });
          if (geometry.index) buffers.push(geometry.index.array.buffer);
          postMessage(
            { type: "decode", id: message.id, geometry: geometry },
            buffers,
          );
        } catch (error) {
          console.error(error);
          postMessage({
            type: "error",
            id: message.id,
            error: error.message,
          });
        } finally {
          draco.destroy(decoder);
        }
      });
      break;
    }
  }
};

function decodeGeometry(draco, decoder, array, taskConfig) {
  const attributeIDs = taskConfig.attributeIDs;
  const attributeTypes = taskConfig.attributeTypes;
  let dracoGeometry;
  const geometryType = decoder.GetEncodedGeometryType(array);
  if (geometryType === draco.TRIANGULAR_MESH) {
    dracoGeometry = new draco.Mesh();
    decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
  } else if (geometryType === draco.POINT_CLOUD) {
    dracoGeometry = new draco.PointCloud();
    decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
  } else {
    throw new Error("THREE.DRACOLoader: Unexpected geometry type.");
  }
  const geometry = { index: null, attributes: [] };
  for (const attributeName in attributeIDs) {
    const attributeType = self[attributeTypes[attributeName]];
    let attribute;
    let attributeID;
    if (taskConfig.useUniqueIDs) {
      attributeID = attributeIDs[attributeName];
      attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeID);
    } else {
      attributeID = decoder.GetAttributeId(
        dracoGeometry,
        draco[attributeIDs[attributeName]],
      );
      if (attributeID === -1) continue;
      attribute = decoder.GetAttribute(dracoGeometry, attributeID);
    }
    const attributeResult = decodeAttribute(
      draco,
      decoder,
      dracoGeometry,
      attributeName,
      attributeType,
      attribute,
    );
    if (attributeName === "color") {
      attributeResult.vertexColorSpace = taskConfig.vertexColorSpace;
    }
    geometry.attributes.push(attributeResult);
  }
  if (geometryType === draco.TRIANGULAR_MESH) {
    geometry.index = decodeIndex(draco, decoder, dracoGeometry);
  }
  draco.destroy(dracoGeometry);
  return geometry;
}

function decodeAttribute(
  draco,
  decoder,
  dracoGeometry,
  attributeName,
  TypedArrayCtor,
  attribute,
) {
  const count = dracoGeometry.num_points();
  const itemSize = attribute.num_components();
  const dracoDataType = getDracoDataType(draco, TypedArrayCtor);
  const srcByteStride = itemSize * TypedArrayCtor.BYTES_PER_ELEMENT;
  const dstByteStride = Math.ceil(srcByteStride / 4) * 4;
  const dstStride = dstByteStride / TypedArrayCtor.BYTES_PER_ELEMENT;
  const srcByteLength = count * srcByteStride;
  const dstByteLength = count * dstByteStride;
  const ptr = draco._malloc(srcByteLength);
  decoder.GetAttributeDataArrayForAllPoints(
    dracoGeometry,
    attribute,
    dracoDataType,
    srcByteLength,
    ptr,
  );
  const srcArray = new TypedArrayCtor(
    draco.HEAPU8.buffer,
    ptr,
    srcByteLength / TypedArrayCtor.BYTES_PER_ELEMENT,
  );
  let dstArray;
  if (srcByteStride === dstByteStride) {
    dstArray = srcArray.slice();
  } else {
    dstArray = new TypedArrayCtor(
      dstByteLength / TypedArrayCtor.BYTES_PER_ELEMENT,
    );
    let dstOffset = 0;
    for (let i = 0, il = srcArray.length; i < il; i += itemSize) {
      for (let j = 0; j < itemSize; j++) {
        dstArray[dstOffset + j] = srcArray[i + j];
      }
      dstOffset += dstStride;
    }
  }
  draco._free(ptr);
  const attributeResult = {
    name: attributeName,
    array: dstArray,
    itemSize: itemSize,
  };
  return attributeResult;
}

function getDracoDataType(draco, TypedArrayCtor) {
  const map = {
    Float32Array: draco.DT_FLOAT32,
    Int8Array: draco.DT_INT8,
    Int16Array: draco.DT_INT16,
    Int32Array: draco.DT_INT32,
    Uint8Array: draco.DT_UINT8,
    Uint16Array: draco.DT_UINT16,
    Uint32Array: draco.DT_UINT32,
  };
  return map[TypedArrayCtor.name];
}

function decodeIndex(draco, decoder, dracoGeometry) {
  const numFaces = dracoGeometry.num_faces();
  const numIndices = numFaces * 3;
  const byteLength = numIndices * 4;
  const ptr = draco._malloc(byteLength);
  decoder.GetTrianglesUInt32Array(dracoGeometry, byteLength, ptr);
  const index = new Uint32Array(
    draco.HEAPU8.buffer,
    ptr,
    numIndices,
  ).slice();
  draco._free(ptr);
  return { array: index, itemSize: 1 };
}
