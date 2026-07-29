import { useState, useEffect, useCallback, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  Loader2, RotateCw, Columns, FileWarning,
  Maximize2, Minimize2, MonitorPlay
} from "lucide-react";
import { subscribeFingerprint } from "../hooks/fingerprintStore";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

interface PDFPreviewProps {
  fileName: string;
  filePath: string;
  accentColor: string;
}

type ViewMode = "continuous" | "two";

interface TextSpan {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PageData {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  textSpans: TextSpan[];
  width: number;
  height: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;

// Build text spans from a PDF page at the rendered viewport scale
async function extractTextSpans(
  pdfPage: pdfjsLib.PDFPageProxy,
  vp: pdfjsLib.PageViewport
): Promise<TextSpan[]> {
  try {
    const textContent = await pdfPage.getTextContent();
    return textContent.items.map((item: any) => {
      if (!item.str) return null;
      // item.transform = [fontSize, 0, 0, fontSize, x, y] in PDF coordinate space
      // The viewport transform already scales everything to device pixels,
      // so we transform item.transform through the viewport matrix
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      return {
        text: item.str,
        left: tx[4],
        top: tx[5] - (tx[0] ?? 12) * 0.85, // tx[0] = fontSize in device pixels
        width: (item.width ?? 0),
        height: tx[0] ?? 12,
      };
    }).filter(Boolean) as TextSpan[];
  } catch {
    return [];
  }
}

// Render one PDF page to a canvas element
async function renderPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number,
  rotation: number
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number } | null> {
  try {
    const pdfPage = await doc.getPage(pageNum);
    const vp = pdfPage.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.display = "block";
    const ctx = canvas.getContext("2d")!;
    // pdfjs-dist v4 requires `canvas` in RenderParameters but we manage the
    // canvas ourselves, so we cast to bypass the stricter type check.
    await (pdfPage as any).render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas, width: vp.width, height: vp.height };
  } catch {
    return null;
  }
}

export default function PDFPreview({ fileName, filePath, accentColor }: PDFPreviewProps) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("continuous");
  const [pages, setPages] = useState<PageData[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFocusView, setIsFocusView] = useState(false);
  const [fitScale, setFitScale] = useState(1.0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scaleRef = useRef(1.0);
  const rotRef = useRef(0);
  const vmRef = useRef<ViewMode>("continuous");
  const npRef = useRef(0);

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { rotRef.current = rotation; }, [rotation]);
  useEffect(() => { vmRef.current = viewMode; }, [viewMode]);
  useEffect(() => { npRef.current = numPages; }, [numPages]);

  const bar = "border-white/8";
  const barTxt = "text-stone-400";
  const txt = "text-stone-200";
  const sub = "text-stone-400";
  const btn = "text-stone-400";
  const sep = "bg-white/10";

  // Compute fit-to-width scale
  const computeFitScale = useCallback(async () => {
    const vpEl = viewportRef.current;
    const doc = docRef.current;
    if (!vpEl || !doc) return 1.0;
    try {
      const p1 = await doc.getPage(1);
      const vp = p1.getViewport({ scale: 1.0, rotation: 0 });
      const avail = vpEl.clientWidth - 32;
      if (vp.width > 0) return avail / vp.width;
    } catch { /* ignore */ }
    return 1.0;
  }, []);

  // Load a new PDF file
  const loadPdf = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setPages([]);
    setNumPages(0);
    setScale(1.0);
    setFitScale(1.0);
    docRef.current = null;

    try {
      const encoded = encodeURIComponent(path);
      const res = await fetch(`http://localhost:18765/file?path=${encoded}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("Empty file");

      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      docRef.current = doc;
      setNumPages(doc.numPages);

      await new Promise(r => setTimeout(r, 60));

      const fs = await computeFitScale();
      scaleRef.current = fs;
      setFitScale(fs);
      setScale(fs);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [computeFitScale]);

  // Load when filePath changes
  useEffect(() => {
    if (!filePath) return;
    loadPdf(filePath);
  }, [filePath, loadPdf]);

  // Force reload PDF when file is replaced. Single source of truth for
  // "file replaced" events lives in fingerprintStore, so we just subscribe.
  useEffect(() => {
    const unsubscribe = subscribeFingerprint((changedPath) => {
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normalize(changedPath) === normalize(filePath)) {
        loadPdf(filePath);
      }
    });
    return unsubscribe;
  }, [filePath, loadPdf]);

  // Render pages for current state
  const renderPages = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;

    const sc = scaleRef.current;
    const rot = rotRef.current;
    const vm = vmRef.current;
    const np = npRef.current;

    let nums: number[];
    if (vm === "continuous") {
      nums = Array.from({ length: np }, (_, i) => i + 1);
    } else {
      nums = [];
      for (let i = 1; i <= np; i += 2) {
        nums.push(i);
        if (i + 1 <= np) nums.push(i + 1);
      }
    }

    const results: PageData[] = [];
    for (const n of nums) {
      try {
        const pdfPage = await doc.getPage(n);
        const vp = pdfPage.getViewport({ scale: sc, rotation: rot });
        const result = await renderPageToCanvas(doc, n, sc, rot);
        if (!result) continue;
        const spans = await extractTextSpans(pdfPage, vp);
        results.push({ pageNumber: n, canvas: result.canvas, textSpans: spans, width: result.width, height: result.height });
      } catch { /* skip */ }
    }
    setPages(results);
  }, []);

  // Re-render when scale / rotation / viewMode changes
  useEffect(() => {
    renderPages();
  }, [scale, rotation, viewMode, renderPages]);

  // Fit to width
  const fitToWidth = useCallback(async () => {
    const fs = await computeFitScale();
    scaleRef.current = fs;
    setFitScale(fs);
    setScale(fs);
  }, [computeFitScale]);

  // Ctrl + wheel zoom
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setScale(prev => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round((prev + delta) * 100) / 100));
        scaleRef.current = next;
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard: Escape exits focus/fullscreen; Ctrl+C copies selected PDF text (stops propagation).
  // Attached to window (not the viewport element) so Escape works even when focus is
  // outside the viewport — mirrors 3DModelViewer's keyboard handler.
  useEffect(() => {
    if (!isFocusView && !isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
        setIsFocusView(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFocusView, isFullscreen]);

  // Ctrl+C inside the viewport copies the selected PDF text. Kept local to
  // the viewport so it doesn't intercept clipboard copy elsewhere in the app.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().trim().length > 0) {
          e.stopPropagation();
          e.preventDefault();
          navigator.clipboard.writeText(sel.toString()).catch(() => {});
          return;
        }
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Fullscreen
  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    else document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Mount pages + text layers into DOM
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pages.length === 0) return;
    container.innerHTML = "";

    if (viewMode === "two") {
      for (let i = 0; i < pages.length; i += 2) {
        const p1 = pages[i];
        const p2 = pages[i + 1];
        const spread = document.createElement("div");
        spread.style.display = "flex";
        spread.style.gap = "8px";
        spread.style.justifyContent = "center";
        spread.style.marginBottom = "8px";
        [p1, p2].forEach(pg => { if (pg) { spread.appendChild(makePageEl(pg)); } });
        container.appendChild(spread);
      }
    } else {
      pages.forEach(pg => { container.appendChild(makePageEl(pg)); });
    }
  }, [pages, viewMode]);

  const scaleDisplay = `${Math.round(scale * 100)}%`;
  const isFitActive = Math.abs(scale - fitScale) < 0.02;
  const isFocused = isFullscreen || isFocusView;

  return (
    <div
      ref={wrapperRef}
      className={`w-full h-full flex flex-col ${isFocused ? "fixed inset-0 z-[500]" : "relative"}`}
        style={{ backgroundColor: 'var(--app-bg)' }}
      >
        {/* Toolbar */}
        <div
          className={`flex items-center gap-1.5 px-3 py-2 border-b shrink-0 select-none ${bar}`}
          style={{ backgroundColor: 'var(--header-bg)', borderColor: 'var(--stroke-1)' }}
        >
        {/* Scale */}
        <span className={`text-[11px] font-mono font-bold min-w-[44px] text-center ${txt}`}>
          {scaleDisplay}
        </span>

        {/* Fit */}
        <button
          onClick={fitToWidth}
          className="p-1.5 rounded text-[10px] font-bold font-mono px-2 border transition-colors"
          style={isFitActive ? { color: accentColor, borderColor: accentColor + "60", opacity: 0.85 } : { color: barTxt, borderColor: "transparent" }}
          title="Fit to width">
          Fit
        </button>

        <div className={`w-px h-5 mx-1 ${sep}`} />

        {/* View mode */}
        <button onClick={() => setViewMode("continuous")}
          className={`p-1.5 rounded transition-colors ${viewMode === "continuous" ? "" : btn}`}
          style={viewMode === "continuous" ? { backgroundColor: accentColor + "30", color: accentColor } : undefined}
          title="Continuous scroll">
          <Columns className="w-4 h-4" />
        </button>
        <button onClick={() => setViewMode("two")}
          className={`p-1.5 rounded transition-colors ${viewMode === "two" ? "" : btn}`}
          style={viewMode === "two" ? { backgroundColor: accentColor + "30", color: accentColor } : undefined}
          title="Two-page spread">
          <FileWarning className="w-4 h-4" />
        </button>

        <button onClick={() => setRotation(r => (r + 90) % 360)}
          className={`p-1.5 rounded transition-colors ${btn}`} title="Rotate 90°">
          <RotateCw className="w-4 h-4" />
        </button>

        <div className="flex-1" />

        <span className={`text-[11px] font-mono font-bold ${sub}`}>
          {numPages > 0 ? `${numPages} page${numPages !== 1 ? "s" : ""}` : ""}
        </span>

        <div className={`w-px h-5 mx-1 ${sep}`} />

        {/* Focus View */}
        <button onClick={() => setIsFocusView(v => !v)}
          className={`p-1.5 rounded transition-colors ${isFocusView ? "" : btn}`}
          style={isFocusView ? { backgroundColor: accentColor + "30", color: accentColor } : undefined}
          title="Focus View">
          <MonitorPlay className="w-4 h-4" />
        </button>

        {/* Fullscreen */}
        <button onClick={toggleFullscreen} className={`p-1.5 rounded transition-colors ${btn}`}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Viewport */}
      {error ? (
        <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: 'var(--row-bg)' }}>
          <div className="flex flex-col items-center gap-3 text-center p-6">
            <FileWarning className="w-12 h-12 text-red-400" />
            <span className={`font-semibold text-sm ${txt}`}>Failed to load PDF</span>
            <span className={`text-xs ${sub}`}>{error}</span>
          </div>
        </div>
      ) : (
        <div
          ref={viewportRef}
          className="flex-1 overflow-auto relative"
          style={{ backgroundColor: 'var(--row-bg)' }}
          onContextMenu={(e) => {
            e.preventDefault();
            const sel = window.getSelection();
            if (sel && sel.toString().trim().length > 0) {
              setContextMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          {loading || pages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: accentColor }} />
                <span className={`text-sm ${sub}`}>Loading PDF...</span>
              </div>
            </div>
          ) : (
            <div
              ref={containerRef}
              className="flex flex-col items-center py-4 px-4"
              style={{ minHeight: "100%" }}
            />
          )}
        </div>
      )}

      {/* PDF text context menu */}
      {contextMenu && (
        <div
          className={`fixed z-[9999] py-1 rounded-lg shadow-2xl border bg-[#1e1e2a] border-white/15`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={`w-full px-4 py-1.5 text-xs text-left text-stone-200`}
            style={{ backgroundColor: 'var(--row-bg)' }}
            onClick={() => {
              const sel = window.getSelection();
              if (sel) navigator.clipboard.writeText(sel.toString()).catch(() => {});
              setContextMenu(null);
            }}
          >
            Copy Text
          </button>
        </div>
      )}
    </div>
  );
}

// Build a page element: wrapper > canvas + text layer (overlay)
function makePageEl(pg: PageData): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.display = "block";
  wrap.style.margin = "4px auto";
  wrap.style.boxShadow = "0 4px 24px rgba(0,0,0,0.3)";

  // Canvas
  const canvasDiv = document.createElement("div");
  canvasDiv.style.position = "relative";
  canvasDiv.style.display = "inline-block";
  canvasDiv.style.lineHeight = "0";
  canvasDiv.appendChild(pg.canvas);
  wrap.appendChild(canvasDiv);

  // Text layer overlay (transparent, selectable)
  if (pg.textSpans.length > 0) {
    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";
    textLayer.style.position = "absolute";
    textLayer.style.top = "0";
    textLayer.style.left = "0";
    textLayer.style.width = `${pg.width}px`;
    textLayer.style.height = `${pg.height}px`;
    textLayer.style.zIndex = "10";
    textLayer.style.color = "transparent";
    textLayer.style.userSelect = "text";
    textLayer.style.webkitUserSelect = "text";
    textLayer.style.overflow = "hidden";
    textLayer.style.pointerEvents = "auto";
    textLayer.style.background = "transparent";

    pg.textSpans.forEach(span => {
      const el = document.createElement("span");
      el.textContent = span.text;
      el.style.position = "absolute";
      el.style.left = `${span.left}px`;
      el.style.top = `${span.top}px`;
      el.style.fontSize = `${span.height}px`;
      el.style.fontFamily = "sans-serif";
      el.style.whiteSpace = "pre";
      el.style.color = "transparent";
      el.style.cursor = "text";
      el.style.display = "inline";
      el.style.userSelect = "text";
      el.style.webkitUserSelect = "text";
      el.style.pointerEvents = "auto";
      textLayer.appendChild(el);
    });

    wrap.appendChild(textLayer);
  }

  return wrap;
}
