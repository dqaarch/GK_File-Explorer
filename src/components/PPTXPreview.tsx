import React, { useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Presentation } from "lucide-react";

interface PPTXPreviewProps {
  filePath: string;
  fileName: string;
  accentColor?: string;
}

export default function PPTXPreview({ filePath, fileName, accentColor = "#ea580c" }: PPTXPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<ReturnType<typeof init> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [currentSlide, setCurrentSlide] = useState(1);

  useEffect(() => {
    if (!containerRef.current || !filePath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSlideCount(0);
    setCurrentSlide(1);

    const loadPptx = async () => {
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

        // Clear container
        containerRef.current.innerHTML = "";

        // Initialize pptx-preview
        const pptxPreviewer = init(containerRef.current, {
          width: containerRef.current.clientWidth || 800,
          height: containerRef.current.clientHeight || 450,
        });

        previewerRef.current = pptxPreviewer;

        // Preview the file
        await pptxPreviewer.preview(arrayBuffer);

        if (!cancelled) {
          setSlideCount(pptxPreviewer.slideCount);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to render PPTX:", err);
          setError(String(err));
          setLoading(false);
        }
      }
    };

    void loadPptx();

    return () => {
      cancelled = true;
      previewerRef.current = null;
    };
  }, [filePath]);

  const handlePrevSlide = () => {
    if (previewerRef.current && currentSlide > 1) {
      previewerRef.current.renderPreSlide();
      setCurrentSlide((prev) => Math.max(1, prev - 1));
    }
  };

  const handleNextSlide = () => {
    if (previewerRef.current && currentSlide < slideCount) {
      previewerRef.current.renderNextSlide();
      setCurrentSlide((prev) => Math.min(slideCount, prev + 1));
    }
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-gray-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <Presentation className="w-4 h-4 text-orange-500" />
        <span className="text-xs font-semibold truncate flex-1" title={fileName} style={{ color: "#000000" }}>
          {fileName}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "#000000" }}>PPTX</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-orange-500" />
              <span className="text-xs" style={{ color: "#000000" }}>Loading presentation...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
            <div className="flex flex-col items-center gap-2 text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <span className="text-sm font-medium text-red-600">Failed to load presentation</span>
              <span className="text-xs max-w-[250px] break-all" style={{ color: "#000000" }}>{error}</span>
            </div>
          </div>
        )}

        {/* PPTX container */}
        <div
          ref={containerRef}
          className="flex-1 bg-white shadow-inner mx-4 my-2 rounded overflow-hidden"
          style={{ minHeight: "200px" }}
        />

        {/* Navigation controls */}
        {!loading && slideCount > 1 && (
          <div className="flex items-center justify-center gap-4 py-2 px-4 bg-white border-t border-gray-200 shrink-0">
            <button
              onClick={handlePrevSlide}
              disabled={currentSlide <= 1}
              className={`
                px-3 py-1 text-xs font-medium rounded transition-colors
                ${currentSlide <= 1
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-orange-500 text-white hover:bg-orange-600"
                }
              `}
            >
              Prev
            </button>

            <div className="flex items-center gap-2 text-xs" style={{ color: "#000000" }}>
              <span className="font-mono">
                {currentSlide} / {slideCount}
              </span>
            </div>

            <button
              onClick={handleNextSlide}
              disabled={currentSlide >= slideCount}
              className={`
                px-3 py-1 text-xs font-medium rounded transition-colors
                ${currentSlide >= slideCount
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-orange-500 text-white hover:bg-orange-600"
                }
              `}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
