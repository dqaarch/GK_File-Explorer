import React, { useEffect, useRef, useState } from "react";
import init, { WasmDocument } from "office-oxide-wasm/web";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Presentation } from "lucide-react";

interface PPTPreviewProps {
  filePath: string;
  fileName: string;
  accentColor?: string;
}

let wasmInitialized = false;

export default function PPTPreview({ filePath, fileName, accentColor = "#f97316" }: PPTPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !filePath) return;

    let cancelled = false;

    const loadPpt = async () => {
      try {
        if (!wasmInitialized) {
          await init();
          wasmInitialized = true;
        }

        if (cancelled || !containerRef.current) return;

        const assetUrl = convertFileSrc(filePath);
        const response = await fetch(assetUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        if (cancelled || !containerRef.current) return;

        const doc = new WasmDocument(bytes, "ppt");
        const html = doc.toHtml();
        doc.free();

        if (cancelled || !containerRef.current) return;

        setHtmlContent(html);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to render PPT:", err);
          setError(String(err));
          setLoading(false);
        }
      }
    };

    setLoading(true);
    setError(null);
    setHtmlContent(null);

    void loadPpt();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-gray-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-300 bg-gray-200 shrink-0">
        <Presentation className="w-4 h-4 text-orange-600" />
        <span className="text-xs font-semibold truncate flex-1" title={fileName} style={{ color: "#000000" }}>
          {fileName}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "#000000" }}>PPT</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto relative p-4">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-orange-500" />
              <span className="text-xs" style={{ color: "#000000" }}>Loading presentation...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="flex flex-col items-center gap-2 text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <span className="text-sm font-medium text-red-600">Failed to load presentation</span>
              <span className="text-xs max-w-[250px] break-all" style={{ color: "#000000" }}>{error}</span>
            </div>
          </div>
        )}

        {/* PPT content container */}
        <div
          ref={containerRef}
          className="office-doc-wrapper"
          style={{ backgroundColor: "#ffffff" }}
          dangerouslySetInnerHTML={htmlContent ? { __html: htmlContent } : undefined}
        />

        {/* Custom styles for PPT content */}
        <style>{`
          .office-doc-wrapper {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif !important;
            font-size: 14px !important;
            line-height: 1.5 !important;
            color: #000000 !important;
            background-color: #ffffff !important;
            padding: 1em !important;
            min-height: 100% !important;
          }

          .office-doc-wrapper * {
            font-family: inherit !important;
            box-sizing: border-box !important;
            color: #000000 !important;
            background-color: inherit !important;
          }

          .office-doc-wrapper h1 {
            font-size: 2em !important;
            font-weight: bold !important;
            margin: 0.5em 0 !important;
            color: #000000 !important;
          }

          .office-doc-wrapper h2 {
            font-size: 1.5em !important;
            font-weight: bold !important;
            margin: 0.5em 0 !important;
            color: #000000 !important;
          }

          .office-doc-wrapper h3 {
            font-size: 1.17em !important;
            font-weight: bold !important;
            margin: 0.5em 0 !important;
            color: #000000 !important;
          }

          .office-doc-wrapper p {
            margin: 0.5em 0 !important;
          }

          .office-doc-wrapper ul, .office-doc-wrapper ol {
            margin: 0.5em 0 !important;
            padding-left: 2em !important;
          }

          .office-doc-wrapper li {
            margin: 0.25em 0 !important;
          }

          .office-doc-wrapper img {
            max-width: 100% !important;
            height: auto !important;
          }

          .office-doc-wrapper table {
            border-collapse: collapse !important;
            margin: 1em 0 !important;
            width: 100% !important;
          }

          .office-doc-wrapper th, .office-doc-wrapper td {
            border: 1px solid #d0d0d0 !important;
            padding: 0.35em 0.5em !important;
            color: #000000 !important;
          }

          .office-doc-wrapper th {
            background-color: #f5f5f5 !important;
            font-weight: bold !important;
          }
        `}</style>
      </div>
    </div>
  );
}
