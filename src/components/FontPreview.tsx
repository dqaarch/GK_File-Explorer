import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, AlertCircle, Type } from "lucide-react";
import * as opentype from "opentype.js";
import { convertFileSrc } from "@tauri-apps/api/core";

interface FontPreviewProps {
  fileName: string;
  filePath: string;
  accentColor: string;
  language?: "en" | "vi";
}

const DEFAULT_SAMPLE_EN = "The quick brown fox jumps over the lazy dog";
const DEFAULT_SAMPLE_VI = "Do hung bay cao vut qua con cho";

// Parse OpenType 'name' table manually as fallback when opentype.js fails
// (e.g. variable fonts, fonts with CFF extension tables)
// Supports TTF, OTF, WOFF, WOFF2 (WOFF2 requires brotli, handled separately)
function parseOpenTypeNameTable(buffer: ArrayBuffer): { label: string; value: string }[] {
  try {
    let dv = new DataView(buffer);
    const magic = dv.getUint32(0, false);
    const magicHex = "0x" + magic.toString(16).toUpperCase().padStart(8, "0");
    console.log("[FontPreview] Parsing font buffer, magic:", magicHex);

    // WOFF2: 'wOF2' (0x774F4632) - needs brotli decompression, skip for now
    if (magic === 0x774F4632) {
      console.warn("[FontPreview] WOFF2 not supported in fallback parser (needs brotli)");
      return [];
    }

    // WOFF: 'wOFF' (0x774F4646) - 44-byte header, table records have offset+compLength+origLength
    if (magic === 0x774F4646) {
      const woffFlavor = dv.getUint32(4, false);
      const woffNumTables = dv.getUint16(8, false);
      // Find 'name' table record (still uses 'name' tag)
      let nameCompOffset = -1, nameOrigLength = -1, nameCompLength = -1;
      for (let i = 0; i < woffNumTables; i++) {
        const rOff = 44 + i * 20; // WOFF table record is 20 bytes
        const tag = String.fromCharCode(
          dv.getUint8(rOff), dv.getUint8(rOff + 1),
          dv.getUint8(rOff + 2), dv.getUint8(rOff + 3),
        );
        if (tag === "name") {
          nameCompOffset = dv.getUint32(rOff + 4, false);
          nameCompLength = dv.getUint32(rOff + 8, false);
          nameOrigLength = dv.getUint32(rOff + 12, false);
          break;
        }
      }
      if (nameCompOffset < 0) return [];
      // If compressed, inflate (pako)
      let nameBytes: ArrayBuffer;
      if (nameCompLength !== nameOrigLength) {
        try {
          // @ts-ignore - pako dynamically imported if needed
          // Using built-in DecompressionStream if available (modern browsers/Tauri)
          // Fallback: skip if can't inflate
          const compressed = new Uint8Array(buffer, nameCompOffset, nameCompLength);
          // Try native DecompressionStream
          return inflateAndParseNameTable(compressed, nameOrigLength);
        } catch (e) {
          console.warn("[FontPreview] WOFF inflate failed:", e);
          return [];
        }
      } else {
        nameBytes = buffer.slice(nameCompOffset, nameCompOffset + nameOrigLength);
        dv = new DataView(nameBytes);
      }
      return parseNameTableFromDV(dv, 0, "WOFF");
    }

    // TTF or OTF - parse directly
    return parseNameTableFromDV(dv, 0, "TTF/OTF");
  } catch (e) {
    console.warn("[FontPreview] Name table parse failed:", e);
    return [];
  }
}

// Async inflate (WOFF) then parse name table
async function inflateAndParseNameTableAsync(
  compressed: Uint8Array,
  origLength: number,
): Promise<{ label: string; value: string }[]> {
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const inflated = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      inflated.set(c, off);
      off += c.byteLength;
    }
    const dv = new DataView(inflated.buffer);
    return parseNameTableFromDV(dv, 0, "WOFF-inflated");
  } catch (e) {
    console.warn("[FontPreview] WOFF inflate (DecompressionStream) failed:", e);
    return [];
  }
}

// Sync stub for non-async path (returns empty)
function inflateAndParseNameTable(
  _compressed: Uint8Array,
  _origLength: number,
): { label: string; value: string }[] {
  // WOFF inflate is async-only; main loader will retry via async path
  return [];
}

// Pure parser - takes DataView starting at the name table
function parseNameTableFromDV(
  dv: DataView,
  baseOffset: number,
  source: string,
): { label: string; value: string }[] {
  const NAME_IDS: Record<number, string> = {
    0: "Copyright",
    1: "Family",
    2: "Style",
    3: "Unique ID",
    4: "Full Name",
    5: "Version",
    6: "PostScript Name",
    7: "Trademark",
    8: "Manufacturer",
    9: "Designer",
    10: "Description",
    11: "Vendor URL",
    12: "Designer URL",
    13: "License",
    14: "License URL",
    19: "Sample Text",
  };

  // Determine numTables based on source
  let numTables: number;
  let recordsOffset: number;
  if (source === "TTF/OTF") {
    numTables = dv.getUint16(4, false);
    recordsOffset = 12;
  } else {
    // WOFF or WOFF-inflated: already start with name table, numTables not present
    numTables = 0;
    recordsOffset = 0;
  }

  // Find 'name' table (only needed for TTF/OTF)
  let nameOffset = baseOffset;
  if (source === "TTF/OTF") {
    nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const recOffset = recordsOffset + i * 16;
      const tag = String.fromCharCode(
        dv.getUint8(recOffset),
        dv.getUint8(recOffset + 1),
        dv.getUint8(recOffset + 2),
        dv.getUint8(recOffset + 3),
      );
      if (tag === "name") {
        nameOffset = dv.getUint32(recOffset + 8, false);
        break;
      }
    }
    if (nameOffset < 0) return [];
  }

  const format = dv.getUint16(nameOffset, false);
  const count = dv.getUint16(nameOffset + 2, false);
  const stringOffset = dv.getUint16(nameOffset + 4, false);

  type Entry = { nid: number; value: string };
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const recOffset = nameOffset + 6 + i * 12;
    const platformID = dv.getUint16(recOffset, false);
    const encodingID = dv.getUint16(recOffset + 2, false);
    const languageID = dv.getUint16(recOffset + 4, false);
    const nameID = dv.getUint16(recOffset + 6, false);
    const length = dv.getUint16(recOffset + 8, false);
    const strOffset = dv.getUint16(recOffset + 10, false);

    const start = nameOffset + stringOffset + strOffset;
    let value = "";
    if (platformID === 3 || platformID === 0) {
      // UTF-16BE (platform 3) or Unicode (platform 0) - both UTF-16 in modern fonts
      if (length % 2 === 0 && length >= 2) {
        try {
          value = String.fromCharCode(
            ...Array.from({ length: length / 2 }, (_, j) => dv.getUint16(start + j * 2, false)),
          );
        } catch {
          continue;
        }
      } else if (length > 0) {
        // Single-byte fallback
        try {
          value = String.fromCharCode(
            ...Array.from({ length }, (_, j) => dv.getUint8(start + j)),
          );
        } catch {
          continue;
        }
      }
    } else if (platformID === 1 && encodingID === 0) {
      // Mac Roman
      try {
        value = String.fromCharCode(...Array.from({ length }, (_, j) => dv.getUint8(start + j)));
      } catch {
        continue;
      }
    } else {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) entries.push({ nid: nameID, value: trimmed });
  }

  // Pick first non-empty value per name ID
  const seen = new Set<number>();
  const result: { label: string; value: string }[] = [];
  for (const e of entries) {
    if (seen.has(e.nid)) continue;
    seen.add(e.nid);
    const label = NAME_IDS[e.nid];
    if (label) result.push({ label, value: e.value });
  }
  console.log("[FontPreview] " + source + " name table parsed: " + entries.length + " entries, " + result.length + " unique");
  return result;
}

function arrayBufferToHex(buffer: ArrayBuffer, maxBytes = 16): string {
  const dv = new DataView(buffer);
  const bytes = Math.min(buffer.byteLength, maxBytes);
  let hex = "";
  for (let i = 0; i < bytes; i++) {
    hex += dv.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex + (buffer.byteLength > maxBytes ? "..." : "");
}

export default function FontPreview({ fileName, filePath, accentColor, language = "en" }: FontPreviewProps) {
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<{ label: string; value: string }[] | null>(null);
  const [otfFont, setOtfFont] = useState<opentype.Font | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sampleText, setSampleText] = useState(language === "vi" ? DEFAULT_SAMPLE_VI : DEFAULT_SAMPLE_EN);
  const [previewFontSize, setPreviewFontSize] = useState(24);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setMetadata(null);

    // Cleanup previous font from document.fonts
    const previousFamily = fontFamily;
    if (previousFamily) {
      document.fonts.forEach((f) => {
        if (f.family === previousFamily) {
          document.fonts.delete(f);
        }
      });
    }
    setFontFamily(null);

    async function load() {
      try {
        const assetUrl = convertFileSrc(filePath);
        console.log("[FontPreview] Fetching:", assetUrl);
        const response = await fetch(assetUrl);
        if (!response.ok) throw new Error("Failed to fetch font: " + response.status);
        const arrayBuffer = await response.arrayBuffer();
        console.log("[FontPreview] Got ArrayBuffer, bytes:", arrayBuffer.byteLength);
        if (cancelled) return;

        // Clone buffer because opentype.parse may transfer/detach the original
        const bufferForFontFace = arrayBuffer.slice(0);

        let parsedFont: opentype.Font | null = null;
        let nameMetadata: { label: string; value: string }[] = [];
        try {
          parsedFont = opentype.parse(arrayBuffer);
          if (parsedFont) {
            const names = parsedFont.names as any;
            const platforms = Object.keys(names);
            const get = (key: string): string | null => {
              for (const p of platforms) {
                const entry = names[p]?.[key];
                if (entry) {
                  if (typeof entry === "string") return entry;
                  return entry.en || entry.vi || Object.values(entry as Record<string, string>)[0] || null;
                }
              }
              return null;
            };
            const map: Record<string, string | null> = {
              Copyright: get("copyright"),
              Family: get("fontFamily"),
              Style: get("fontSubfamily"),
              "Unique ID": get("uniqueID") || get("uniqueIdentifier"),
              "Full Name": get("fullName"),
              Version: get("version"),
              "PostScript Name": get("postScriptName"),
              Trademark: get("trademark"),
              Manufacturer: get("manufacturer"),
              Designer: get("designer"),
              Description: get("description"),
              "Vendor URL": get("vendorURL"),
              "Designer URL": get("designerURL"),
              License: get("license"),
              "License URL": get("licenseURL"),
              "Sample Text": get("sampleText"),
            };
            nameMetadata = Object.entries(map)
              .filter(([, v]) => v)
              .map(([label, value]) => ({ label, value: value! }));
          }
        } catch (e) {
          console.warn("[FontPreview] opentype.parse failed, falling back to manual parse:", e);
        }
        if (!parsedFont) {
          nameMetadata = parseOpenTypeNameTable(arrayBuffer);
          // For WOFF compressed - try async inflate
          if (nameMetadata.length === 0) {
            const dv = new DataView(arrayBuffer);
            const magic = dv.getUint32(0, false);
            if (magic === 0x774F4646) {
              const woffNumTables = dv.getUint16(8, false);
              let nameCompOffset = -1, nameCompLength = -1, nameOrigLength = -1;
              for (let i = 0; i < woffNumTables; i++) {
                const rOff = 44 + i * 20;
                const tag = String.fromCharCode(
                  dv.getUint8(rOff), dv.getUint8(rOff + 1),
                  dv.getUint8(rOff + 2), dv.getUint8(rOff + 3),
                );
                if (tag === "name") {
                  nameCompOffset = dv.getUint32(rOff + 4, false);
                  nameCompLength = dv.getUint32(rOff + 8, false);
                  nameOrigLength = dv.getUint32(rOff + 12, false);
                  break;
                }
              }
              if (nameCompOffset >= 0 && nameCompLength !== nameOrigLength) {
                try {
                  const compressed = new Uint8Array(arrayBuffer, nameCompOffset, nameCompLength);
                  const ds = new DecompressionStream("deflate");
                  const writer = ds.writable.getWriter();
                  writer.write(compressed);
                  writer.close();
                  const reader = ds.readable.getReader();
                  const chunks: Uint8Array[] = [];
                  while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                  }
                  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
                  const inflated = new Uint8Array(total);
                  let off = 0;
                  for (const c of chunks) { inflated.set(c, off); off += c.byteLength; }
                  nameMetadata = parseNameTableFromDV(new DataView(inflated.buffer), 0, "WOFF-inflated");
                } catch (e) {
                  console.warn("[FontPreview] WOFF inflate failed:", e);
                }
              }
            }
          }
        }
        // Add file size info
        const sizeKB = (arrayBuffer.byteLength / 1024).toFixed(1);
        nameMetadata.push({ label: "File Size", value: `${sizeKB} KB` });

        // Generate a valid CSS font-family name (no spaces, dashes OK)
        const family = "fp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const fontFace = new FontFace(family, bufferForFontFace);
        await fontFace.load();
        if (cancelled) {
          return;
        }
        document.fonts.add(fontFace);
        // Force browser to actually resolve this font (don't just register it)
        await document.fonts.load("16px " + family);
        await document.fonts.ready;
        const isAvailable = document.fonts.check("16px " + family);

        const safeMetadata = nameMetadata;
        const safeOtfFont = parsedFont;
        setFontFamily(family);
        setMetadata(safeMetadata);
        setOtfFont(safeOtfFont);
        setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error("[FontPreview] Error:", err);
          setError(err instanceof Error ? err.message : "Failed to load font");
          setIsLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      // Cleanup font face on unmount/file change
      const family = fontFamily;
      if (family) {
        document.fonts.forEach((f) => {
          if (f.family === family) {
            document.fonts.delete(f);
          }
        });
      }
    };
  }, [filePath]);

  const glyphSets = useMemo(() => [
    { label: "A-Z", chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    { label: "a-z", chars: "abcdefghijklmnopqrstuvwxyz" },
    { label: "0-9", chars: "0123456789" },
    { label: "Special", chars: "!@#$%&*()-+=[]{}" }
  ], []);

  const fontFamilyCss = fontFamily ? `"${fontFamily}", sans-serif` : "sans-serif";
  const previewClassName = fontFamily ? `font-preview-${fontFamily}` : "";

  // Inject @font-face via style tag (some WebViews need this for font-family to resolve)
  useEffect(() => {
    if (!fontFamily) return;
    const styleId = `font-preview-style-${fontFamily}`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${previewClassName} {
        font-family: "${fontFamily}", sans-serif !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, [fontFamily, previewClassName]);

  if (isLoading) return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <Type className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
        <span className="text-xs font-semibold truncate flex-1" style={{ color: "var(--text-primary)" }}>{fileName}</span>
      </div>
      <div className="flex flex-col items-center justify-center flex-1 gap-3">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: accentColor }} />
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading font...</span>
      </div>
    </div>
  );

  if (error) return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <Type className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
        <span className="text-xs font-semibold truncate flex-1" style={{ color: "var(--text-primary)" }}>{fileName}</span>
      </div>
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-4">
        <AlertCircle className="w-8 h-8" style={{ color: "var(--text-error)" }} />
        <span className="text-sm text-center" style={{ color: "var(--text-secondary)" }}>{error}</span>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <Type className="w-4 h-4" style={{ color: "var(--text-secondary)" }} />
        <span className="text-xs font-semibold truncate flex-1" style={{ color: "var(--text-primary)" }}>{fileName}</span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Inject @font-face style as backup */}
        {fontFamily && (
          <style>{`@font-face { font-family: "${fontFamily}"; src: local("${fontFamily}"); font-display: swap; }`}</style>
        )}
        {/* Font Preview - text color follows theme via CSS var */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Preview
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{previewFontSize}px</span>
              <input
                type="range"
                min={12}
                max={120}
                step={1}
                value={previewFontSize}
                onChange={(e) => setPreviewFontSize(Number(e.target.value))}
                className="w-24"
                style={{ accentColor: accentColor }}
              />
              <button
                type="button"
                onClick={() => setPreviewFontSize(24)}
                className="text-xs px-1.5 py-0.5 rounded hover:bg-white/10"
                style={{ color: "var(--text-tertiary)" }}
                title="Reset"
              >
                ↺
              </button>
            </div>
          </div>
          <div
            className={`p-4 rounded ${previewClassName}`}
            style={{
              backgroundColor: "rgba(128,128,128,0.1)",
              color: "var(--text-primary)",
              fontSize: previewFontSize,
              lineHeight: 1.4,
              wordBreak: "break-word",
              overflowWrap: "break-word",
            }}
          >
            {sampleText}
          </div>
        </div>

        {/* Sample Text Input */}
        <div className="space-y-2">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Sample Text
          </span>
          <input
            type="text"
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            placeholder={language === "vi" ? "Nhập text mẫu..." : "Enter sample text..."}
            className="w-full px-3 py-2 rounded text-sm outline-none"
            style={{
              backgroundColor: "rgba(128,128,128,0.1)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-primary)",
            }}
          />
        </div>

        {/* Glyph Grid - use CSS rendering so font-family actually applies */}
        {glyphSets.map(({ label, chars }) => (
          <div key={label} className="space-y-2">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              {label}
            </span>
            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(32px, 1fr))" }}
            >
              {chars.split("").map((c) => (
                <div
                  key={c}
                  className={`flex items-center justify-center rounded text-lg ${previewClassName}`}
                  style={{
                    width: 32,
                    height: 32,
                    backgroundColor: "rgba(128,128,128,0.1)",
                    color: "var(--text-primary)",
                  }}
                  title={c}
                >
                  {c}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Font Info */}
        <div className="space-y-2">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Font Info
          </span>
          <div
            className="rounded p-3 text-xs"
            style={{ backgroundColor: "rgba(128,128,128,0.1)" }}
          >
            {metadata && metadata.length > 0 ? (
              <div className="space-y-1.5">
                {metadata.map(({ label, value }) => (
                  <div key={label} className="flex gap-2 items-start">
                    <span
                      style={{
                        color: "var(--text-tertiary)",
                        minWidth: 110,
                        flexShrink: 0,
                      }}
                    >
                      {label}:
                    </span>
                    <span
                      style={{
                        color: "var(--text-primary)",
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {label.endsWith("URL") ? (
                        <a
                          href={value}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: accentColor, textDecoration: "underline" }}
                        >
                          {value}
                        </a>
                      ) : (
                        value
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "var(--text-tertiary)" }}>No metadata available</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}