import { useState, useCallback, useEffect, useRef } from "react";
import * as opentype from "opentype.js";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface FontMetadata {
  familyName: string;
  fullName: string;
  postScriptName: string;
  version: string;
  designer: string;
  manufacturer: string;
  license: string;
  glyphCount: number;
  unitsPerEm: number;
  ascender: number;
  descender: number;
}

export interface FontPreviewResult {
  fontFamily: string;
  metadata: FontMetadata;
  opentypeFont: opentype.Font | null;
  isLoading: boolean;
  error: string | null;
}

export interface useFontPreviewReturn {
  result: FontPreviewResult | null;
  isLoading: boolean;
  error: string | null;
  loadFont: () => Promise<void>;
  unloadFont: () => void;
}

export function useFontPreview(filePath: string | null): useFontPreviewReturn {
  const [result, setResult] = useState<FontPreviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFontFamilyRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const unloadFont = useCallback(() => {
    const fontFamily = loadedFontFamilyRef.current;
    if (fontFamily) {
      document.fonts.forEach((font) => {
        if (font.family === fontFamily) {
          document.fonts.delete(font);
        }
      });
      loadedFontFamilyRef.current = null;
    }
    setResult(null);
    setError(null);
  }, []);

  const loadFont = useCallback(async () => {
    if (!filePath) {
      setError("No file path provided");
      return;
    }

    cancelledRef.current = false;
    setIsLoading(true);
    setError(null);

    try {
      unloadFont();
      if (cancelledRef.current) return;

      const assetUrl = convertFileSrc(filePath);
      const response = await fetch(assetUrl);
      if (!response.ok) throw new Error("Failed to fetch font: " + response.status);
      const arrayBuffer = await response.arrayBuffer();
      if (cancelledRef.current) return;

      const font = opentype.parse(arrayBuffer);
      if (!font) throw new Error("Failed to parse font file");
      if (cancelledRef.current) return;

      const names = font.names;
      const metadata: FontMetadata = {
        familyName: names.fontFamily?.en || names.fontFamily?.vi || "Unknown",
        fullName: names.fullName?.en || names.fullName?.vi || names.fontFamily?.en || "Unknown",
        postScriptName: names.postScriptName?.en || "",
        version: names.version?.en || "",
        designer: names.designer?.en || names.designer?.vi || "",
        manufacturer: names.manufacturer?.en || names.manufacturer?.vi || "",
        license: names.license?.en || names.license?.vi || "",
        glyphCount: font.glyphs.length,
        unitsPerEm: font.unitsPerEm,
        ascender: font.ascender,
        descender: font.descender,
      };

      if (cancelledRef.current) return;

      const fontFamily = "preview-font-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
      const fontFace = new FontFace(fontFamily, arrayBuffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      loadedFontFamilyRef.current = fontFamily;

      setResult({ fontFamily, metadata, opentypeFont: font, isLoading: false, error: null });
      setIsLoading(false);
    } catch (err) {
      if (!cancelledRef.current) {
        console.error("Font preview error:", err);
        setError(err instanceof Error ? err.message : "Failed to load font");
        setIsLoading(false);
      }
    }
  }, [filePath, unloadFont]);

  useEffect(() => {
    cancelledRef.current = true;
    unloadFont();
  }, [filePath, unloadFont]);

  return { result, isLoading, error, loadFont, unloadFont };
}
