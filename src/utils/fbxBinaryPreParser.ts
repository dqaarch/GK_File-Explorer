// fbxBinaryPreParser.ts — extract FBX native frame rate from raw FBX bytes
//
// Reads only the top of the FBX file (header + GlobalSettings subtree) until
// it finds TimeMode / CustomFrameRate in Properties70. Stops immediately
// afterwards — we don't need the rest of the tree.
//
// Mirrors three.js FBXLoader's BinaryParser format exactly: per-node header
// (endOffset, numProperties, propListLen, nameLen, name), then a property
// list we walk type-tag-by-type-tag, then child nodes until endOffset.
//
// Frame rate storage in FBX (per FBX SDK docs):
//   GlobalSettings
//     Properties70
//       P: "TimeMode",        "enum",     "", "", <int>     ← enum value
//       P: "CustomFrameRate", "double",   "", "", <double>  ← when TimeMode is Custom
//
// We extract TimeMode (and CustomFrameRate as fallback). The TimeMode enum
// maps to fps via a known table; some recent FBX versions also store
// NTSC-style fractional rates (23.976, 29.97, 59.94) as enum 72/73/75.

const TIME_MODE_FPS: Record<number, number> = {
  1: 120,
  2: 100,
  3: 96,
  4: 72,
  5: 60,
  6: 60,
  7: 50,
  8: 48,
  9: 30,
  10: 30, // drop frame
  11: 25,
  12: 24,
  13: 24,
  14: 24,
  15: 30,
  16: 24,
  17: 18,
  18: 16,
  19: 12,
  20: 8,
  21: 6,
  22: 4,
  23: 2,
  24: 1,
  72: 23.976,
  73: 29.97,
  74: 47.952,
  75: 59.94,
};

function timeModeToFps(timeMode: number | null, customRate: number | null): number | null {
  if (timeMode == null) return null;
  if (TIME_MODE_FPS[timeMode] != null) return TIME_MODE_FPS[timeMode];
  // Unknown / Custom enum → use CustomFrameRate if provided.
  if (customRate != null && isFinite(customRate) && customRate > 0) return customRate;
  return null;
}

export function extractFbxFrameRate(buffer: ArrayBuffer): number | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 27) return null;
  const magic = String.fromCharCode(...bytes.slice(0, 20));
  if (!magic.startsWith("Kaydara FBX Binary")) {
    return extractFbxFrameRateFromAscii(buffer);
  }
  const view = new DataView(buffer);
  const version = view.getUint32(23);
  if (version < 6400) return null;
  const use64 = version >= 7500;
  // GlobalSettings is one of the first top-level nodes; we scan until we
  // find it (or run out of buffer at 32KB which is way past the header).
  return walkForGlobalSettings(view, bytes, 27, use64);
}

// ---------- Binary walker ----------
//
// Each binary node has this structure:
//   uint32/64  endOffset          // absolute offset where this node + children ends
//   uint32/64  numProperties
//   uint32/64  propListLen        // unused; we walk properties by tag
//   uint8      nameLen
//   char[]     name
//   Property[numProperties]       // sequential, walked by type tag
//   ChildNode[]                   // nested until offset == endOffset
//
// The top-level FBX file is a list of root nodes — siblings share the same
// parent's endOffset. After all root nodes there's a NULL record (endOffset=0)
// marking end of file. We scan root-level until we hit a node named
// "GlobalSettings" or we run past it.

function walkForGlobalSettings(
  view: DataView,
  bytes: Uint8Array,
  start: number,
  use64: boolean,
): number | null {
  let offset = start;
  // Hard cap: if we haven't found GlobalSettings in the first 32 KB after the
  // header, the file is unusual enough that we give up rather than walk the
  // entire mesh tree.
  const cap = Math.min(bytes.length, start + 32 * 1024);
  while (offset < cap) {
    const node = readNodeHeader(view, bytes, offset, use64);
    if (!node) return null;
    if (node.endOffset === 0) return null; // null-record terminator
    if (node.name === "GlobalSettings") {
      // Skip past the property list, then walk its children looking for Properties70.
      const childStart = skipPropertyList(view, bytes, node.propsStart, node.numProperties);
      return walkSettingsChildren(view, bytes, childStart, node.endOffset, use64);
    }
    // Not the target — jump to the end of this node's entire subtree to find the
    // next sibling at the same level.
    offset = node.endOffset;
  }
  return null;
}

// Walk GlobalSettings' child nodes until we find one named Properties70, then
// walk Properties70's child nodes (all named "P") looking for TimeMode /
// CustomFrameRate labels.
function walkSettingsChildren(
  view: DataView,
  bytes: Uint8Array,
  start: number,
  parentEnd: number,
  use64: boolean,
): number | null {
  let offset = start;
  while (offset < parentEnd) {
    const node = readNodeHeader(view, bytes, offset, use64);
    if (!node) return null;
    if (node.endOffset === 0 || node.endOffset > parentEnd) return null;
    if (node.name === "Properties70") {
      const childStart = skipPropertyList(view, bytes, node.propsStart, node.numProperties);
      return walkP70Entries(view, bytes, childStart, node.endOffset, use64);
    }
    offset = node.endOffset;
  }
  return null;
}

// Walk Properties70 children. Each child is named "P" with one String property
// being the field label (e.g. "TimeMode"). We scan labels and decode the
// matching values.
function walkP70Entries(
  view: DataView,
  bytes: Uint8Array,
  start: number,
  parentEnd: number,
  use64: boolean,
): number | null {
  let offset = start;
  let timeMode: number | null = null;
  let customRate: number | null = null;
  while (offset < parentEnd) {
    const node = readNodeHeader(view, bytes, offset, use64);
    if (!node) return null;
    if (node.endOffset === 0 || node.endOffset > parentEnd) return null;
    if (node.name === "P" && node.numProperties >= 5) {
      // First property is a String with the label.
      const label = readStringProperty(view, bytes, node.propsStart);
      if (label != null) {
        if (label.value === "TimeMode") {
          // Properties after label: type, subType, "", "", then the int value.
          // Skip 4 string properties after the label, then read int.
          let p = label.next;
          for (let i = 0; i < 4; i++) {
            const s = readStringProperty(view, bytes, p);
            if (!s) { p = -1; break; }
            p = s.next;
          }
          if (p >= 0) timeMode = readIntValue(view, bytes, p);
        } else if (label.value === "CustomFrameRate") {
          let p = label.next;
          for (let i = 0; i < 4; i++) {
            const s = readStringProperty(view, bytes, p);
            if (!s) { p = -1; break; }
            p = s.next;
          }
          if (p >= 0) customRate = readDoubleValue(view, bytes, p);
        }
      }
    }
    offset = node.endOffset;
  }
  return timeModeToFps(timeMode, customRate);
}

// ---------- Property readers ----------

// Read a "S" or "R" property: [uint8 tag='S'][uint32 len][bytes].
function readStringProperty(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } | null {
  if (offset + 5 > bytes.length) return null;
  const tag = String.fromCharCode(bytes[offset]);
  if (tag !== "S" && tag !== "R") return null;
  const len = view.getUint32(offset + 1);
  const start = offset + 5;
  const end = start + len;
  if (end > bytes.length) return null;
  const value = String.fromCharCode(...bytes.slice(start, end));
  return { value, next: end };
}

// Read an int value at offset (after the type tag). Reads 'I' or 'i' / 'Y'.
function readIntValue(view: DataView, bytes: Uint8Array, offset: number): number | null {
  if (offset >= bytes.length) return null;
  const tag = String.fromCharCode(bytes[offset]);
  offset += 1;
  if (tag === "I" || tag === "i") {
    if (offset + 4 > bytes.length) return null;
    return view.getInt32(offset);
  }
  if (tag === "Y") {
    if (offset + 2 > bytes.length) return null;
    return view.getInt16(offset);
  }
  return null;
}

// Read a double value at offset (after the type tag). 'D' / 'F' / 'I' / 'i'.
function readDoubleValue(view: DataView, bytes: Uint8Array, offset: number): number | null {
  if (offset >= bytes.length) return null;
  const tag = String.fromCharCode(bytes[offset]);
  offset += 1;
  if (tag === "D") {
    if (offset + 8 > bytes.length) return null;
    return view.getFloat64(offset);
  }
  if (tag === "F") {
    if (offset + 4 > bytes.length) return null;
    return view.getFloat32(offset);
  }
  if (tag === "I" || tag === "i") {
    if (offset + 4 > bytes.length) return null;
    return view.getInt32(offset);
  }
  return null;
}

// Skip past numProperties properties starting at offset. Returns the offset
// of the first child node (or the parent's endOffset if no children).
function skipPropertyList(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  numProperties: number,
): number {
  for (let i = 0; i < numProperties; i++) {
    if (offset >= bytes.length) return offset;
    const tag = String.fromCharCode(bytes[offset]);
    offset += 1;
    if (tag === "S" || tag === "R") {
      if (offset + 4 > bytes.length) return bytes.length;
      const len = view.getUint32(offset);
      offset += 4 + len;
    } else if (tag === "Y") {
      offset += 2;
    } else if (tag === "C") {
      offset += 1;
    } else if (tag === "I" || tag === "i" || tag === "F") {
      offset += 4;
    } else if (tag === "D" || tag === "L" || tag === "l") {
      offset += 8;
    } else if (tag === "f" || tag === "d") {
      // array of float/double: uint32 count + count*4 or count*8 bytes
      if (offset + 4 > bytes.length) return bytes.length;
      const count = view.getUint32(offset);
      offset += 4 + (tag === "f" ? 4 : 8) * count;
    } else if (tag === "b") {
      if (offset + 4 > bytes.length) return bytes.length;
      const len = view.getUint32(offset);
      offset += 4 + len;
    } else {
      // Unknown tag — bail out so we don't infinite-loop.
      return offset;
    }
  }
  return offset;
}

interface NodeHeader {
  endOffset: number;
  numProperties: number;
  name: string;
  propsStart: number;
}

function readNodeHeader(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  use64: boolean,
): NodeHeader | null {
  const r1 = use64 ? readU64Number(view, bytes, offset) : readU32(view, bytes, offset);
  if (!r1) return null;
  const endOffset = r1.value;
  offset = r1.next;
  const r2 = use64 ? readU64Number(view, bytes, offset) : readU32(view, bytes, offset);
  if (!r2) return null;
  const numProperties = r2.value;
  offset = r2.next;
  // propListLen (discarded)
  const r3 = use64 ? readU64Number(view, bytes, offset) : readU32(view, bytes, offset);
  if (!r3) return null;
  offset = r3.next;
  // name
  if (offset + 1 > bytes.length) return null;
  const nameLen = bytes[offset];
  const nameStart = offset + 1;
  const nameEnd = nameStart + nameLen;
  if (nameEnd > bytes.length) return null;
  const name = String.fromCharCode(...bytes.slice(nameStart, nameEnd));
  return {
    endOffset,
    numProperties,
    name,
    propsStart: nameEnd,
  };
}

function readU32(view: DataView, bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  if (offset + 4 > bytes.length) return null;
  return { value: view.getUint32(offset), next: offset + 4 };
}
function readU64Number(view: DataView, bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  if (offset + 8 > bytes.length) return null;
  return { value: Number(view.getBigUint64(offset)), next: offset + 8 };
}

// ---------- ASCII FBX ----------

function extractFbxFrameRateFromAscii(buffer: ArrayBuffer): number | null {
  const bytes = new Uint8Array(buffer);
  const slice = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  let text = "";
  for (let i = 0; i < slice.length; i++) text += String.fromCharCode(slice[i]);
  const tmMatch = text.match(/P:\s*"TimeMode"\s*,\s*"enum"\s*,\s*"",\s*"",\s*(-?\d+)/);
  const cfMatch = text.match(/P:\s*"CustomFrameRate"\s*,\s*"double"\s*,\s*"Number"\s*,\s*"",\s*([\d.\-]+)/);
  const timeMode = tmMatch ? parseInt(tmMatch[1], 10) : null;
  const customRate = cfMatch ? parseFloat(cfMatch[1]) : null;
  return timeModeToFps(timeMode, customRate);
}