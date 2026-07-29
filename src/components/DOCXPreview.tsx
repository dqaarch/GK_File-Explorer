import React, { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { Loader2, AlertCircle, FileText } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface DOCXPreviewProps {
  filePath: string;
  fileName: string;
  accentColor?: string;
}

export default function DOCXPreview({ filePath, fileName, accentColor = "#ea580c" }: DOCXPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !filePath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadDocx = async () => {
      try {
        // Create asset URL for the file
        const assetUrl = convertFileSrc(filePath);

        // Fetch the file
        const response = await fetch(assetUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        if (cancelled) return;
        if (!containerRef.current) return;

        // Clear previous content
        containerRef.current.innerHTML = "";

        // Render DOCX to HTML
        await renderAsync(arrayBuffer, containerRef.current, undefined, {
          className: "docx-wrapper",
          inWrapper: true,
          ignoreWidth: true,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderChanges: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderAltChunks: true,
          debug: false,
        });

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to render DOCX:", err);
          setError(String(err));
          setLoading(false);
        }
      }
    };

    void loadDocx();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
        <FileText className="w-4 h-4 text-blue-600" />
        <span className="text-xs font-semibold truncate flex-1" title={fileName} style={{ color: "#000000" }}>
          {fileName}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "#000000" }}>DOCX</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
              <span className="text-xs" style={{ color: "#000000" }}>Loading document...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
            <div className="flex flex-col items-center gap-2 text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <span className="text-sm font-medium text-red-600">Failed to load document</span>
              <span className="text-xs max-w-[250px] break-all" style={{ color: "#000000" }}>{error}</span>
            </div>
          </div>
        )}

        {/* DOCX content container */}
        <div
          ref={containerRef}
          className="min-h-full p-4"
          style={{
            backgroundColor: "#ffffff",
          }}
        />

        {/* Custom styles for DOCX content */}
        <style>{`
          .docx-wrapper {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif !important;
            font-size: 11px !important;
            line-height: 1.5 !important;
            color: #1a1a1a !important;
          }

          .docx-wrapper * {
            font-family: inherit !important;
            box-sizing: border-box !important;
          }

          .docx-wrapper p {
            margin: 0 0 0.5em 0 !important;
          }

          .docx-wrapper h1 {
            font-size: 2em !important;
            font-weight: bold !important;
            margin: 0.67em 0 !important;
            color: #000000 !important;
          }

          .docx-wrapper h2 {
            font-size: 1.5em !important;
            font-weight: bold !important;
            margin: 0.83em 0 !important;
            color: #000000 !important;
          }

          .docx-wrapper h3 {
            font-size: 1.17em !important;
            font-weight: bold !important;
            margin: 1em 0 !important;
            color: #000000 !important;
          }

          .docx-wrapper h4, .docx-wrapper h5, .docx-wrapper h6 {
            font-weight: bold !important;
            color: #000000 !important;
          }

          .docx-wrapper ul, .docx-wrapper ol {
            margin: 0.5em 0 !important;
            padding-left: 2em !important;
          }

          .docx-wrapper li {
            margin: 0.25em 0 !important;
          }

          .docx-wrapper table {
            border-collapse: collapse !important;
            margin: 1em 0 !important;
            width: 100% !important;
          }

          .docx-wrapper th, .docx-wrapper td {
            border: 1px solid #d0d0d0 !important;
            padding: 0.35em 0.5em !important;
            text-align: left !important;
          }

          .docx-wrapper th {
            background-color: #f5f5f5 !important;
            font-weight: bold !important;
          }

          .docx-wrapper img {
            max-width: 100% !important;
            height: auto !important;
            margin: 0.5em 0 !important;
          }

          .docx-wrapper pre, .docx-wrapper code {
            background-color: #f5f5f5 !important;
            border-radius: 3px !important;
            font-family: 'Consolas', 'Courier New', monospace !important;
            font-size: 0.9em !important;
          }

          .docx-wrapper pre {
            padding: 0.5em !important;
            overflow-x: auto !important;
          }

          .docx-wrapper code {
            padding: 0.1em 0.3em !important;
          }

          .docx-wrapper blockquote {
            border-left: 3px solid #d0d0d0 !important;
            margin: 1em 0 !important;
            padding-left: 1em !important;
            color: #555555 !important;
          }

          /* Page break styling */
          .docx-wrapper [data-page-number] {
            border-bottom: 1px dashed #e0e0e0 !important;
            padding-bottom: 0.5em !important;
            margin-bottom: 0.5em !important;
          }
        `}</style>
      </div>
    </div>
  );
}
