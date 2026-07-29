import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, ChevronRight, ChevronDown, BookOpen, User, Building, Globe, List, FileText, Maximize2, Minimize2 } from "lucide-react";
import { decodeEpub, EpubDecodeResult, EpubTocEntry, EpubChapterContent } from "../TauriFileSystem";

interface EPUBPreviewProps {
  fileName: string;
  filePath: string;
  accentColor: string;
}

export default function EPUBPreview({ fileName, filePath, accentColor }: EPUBPreviewProps) {
  const [data, setData] = useState<EpubDecodeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeTab, setActiveTab] = useState<"cover" | "toc" | "preview">("cover");
  const [expandedToc, setExpandedToc] = useState<Set<number>>(new Set());
  const [selectedTocIndex, setSelectedTocIndex] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<{title: string; content: string} | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  // Find matching chapter content for a TOC entry
  const findChapterContent = useCallback((tocIndex: number): {title: string; content: string} | null => {
    if (!data?.chapters || data.chapters.length === 0) return null;
    
    const tocEntry = data.table_of_contents[tocIndex];
    if (!tocEntry) return null;
    
    // Try to match by index first (most reliable)
    if (tocIndex < data.chapters.length) {
      const chapter = data.chapters[tocIndex];
      return {
        title: chapter.title || tocEntry.title,
        content: chapter.content
      };
    }
    
    // Fallback: try to match by title similarity
    for (const chapter of data.chapters) {
      if (chapter.title && tocEntry.title) {
        const chapterTitleLower = chapter.title.toLowerCase();
        const tocTitleLower = tocEntry.title.toLowerCase();
        if (chapterTitleLower.includes(tocTitleLower) || tocTitleLower.includes(chapterTitleLower)) {
          return {
            title: chapter.title,
            content: chapter.content
          };
        }
      }
    }
    
    return null;
  }, [data]);

  const loadEpub = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await decodeEpub(path);
      if (result.success) {
        setData(result);
      } else {
        setError(result.error || "Failed to decode EPUB");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!filePath) return;
    loadEpub(filePath);
  }, [filePath, loadEpub]);

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  const toggleTocEntry = (index: number) => {
    setExpandedToc(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Handle TOC item click - switch to preview and scroll to content
  const handleTocClick = (index: number) => {
    setSelectedTocIndex(index);
    setExpandedToc(prev => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    
    // Find the matching chapter content
    const chapterContent = findChapterContent(index);
    if (chapterContent) {
      setPreviewContent(chapterContent);
    } else {
      setPreviewContent(null);
    }
    
    // Switch to preview tab to show content
    setActiveTab("preview");
    // Scroll to top of preview after tab switch
    setTimeout(() => {
      if (previewScrollRef.current) {
        previewScrollRef.current.scrollTop = 0;
      }
    }, 50);
  };

  if (loading) {
    return (
      <div className="flex flex-col flex-1 h-full justify-center items-center text-center p-4">
        <Loader2 className="w-10 h-10 animate-spin mb-3" style={{ color: accentColor }} />
        <span className="text-stone-400 text-sm">Loading EPUB...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col flex-1 h-full justify-center items-center text-center p-4">
        <FileText className="w-12 h-12 text-red-400 mb-3 opacity-50" />
        <span className="text-red-400 text-sm font-semibold">Failed to load EPUB</span>
        <span className="text-stone-500 text-xs mt-1">{error}</span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div
      ref={wrapperRef}
      className={"w-full h-full flex flex-col " + (isFullscreen ? "fixed inset-0 z-[500]" : "relative")}
      style={{ backgroundColor: "var(--app-bg)" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0 select-none"
        style={{ backgroundColor: "var(--header-bg)", borderColor: "var(--stroke-1)" }}
      >
        <BookOpen className="w-4 h-4 text-amber-400" />
        <span className="text-[11px] font-bold text-stone-200 truncate flex-1 min-w-0" title={data.title || fileName}>
          {data.title || fileName}
        </span>
        <div className="flex-1" />
        {data.chapters_count > 0 && (
          <span className="text-[10px] font-mono text-stone-500">
            {data.chapters_count} chapters
          </span>
        )}
        <button
          onClick={toggleFullscreen}
          className="p-1.5 rounded text-stone-400 hover:text-stone-200 transition-colors"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--stroke-1)" }}
      >
        <button
          onClick={() => setActiveTab("cover")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-semibold transition-colors"
          style={activeTab === "cover"
            ? { backgroundColor: accentColor + "30", color: accentColor }
            : { color: "var(--text-secondary)" }
          }
        >
          Cover
        </button>
        <button
          onClick={() => setActiveTab("toc")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-semibold transition-colors"
          style={activeTab === "toc"
            ? { backgroundColor: accentColor + "30", color: accentColor }
            : { color: "var(--text-secondary)" }
          }
        >
          Contents
          {data.table_of_contents.length > 0 && (
            <span
              className="px-1.5 py-0.5 rounded-full text-[9px] font-bold"
              style={{ backgroundColor: activeTab === "toc" ? accentColor + "40" : "var(--stroke-1)", color: activeTab === "toc" ? accentColor : "var(--text-secondary)" }}
            >
              {data.table_of_contents.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("preview")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-semibold transition-colors"
          style={activeTab === "preview"
            ? { backgroundColor: accentColor + "30", color: accentColor }
            : { color: "var(--text-secondary)" }
          }
        >
          Preview
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {activeTab === "cover" && (
          <div className="flex flex-col h-full">
            <div className="flex-1 flex items-center justify-center p-4 overflow-hidden" style={{ minHeight: "200px" }}>
              {data.cover_base64 ? (
                <div className="relative max-w-full max-h-full">
                  <img
                    src={"data:image/png;base64," + data.cover_base64}
                    alt="EPUB Cover"
                    className="max-w-full max-h-[280px] object-contain rounded shadow-2xl"
                    style={{ boxShadow: "0 8px 32px " + accentColor + "30" }}
                  />
                  {data.cover_width && data.cover_height && (
                    <div className="absolute -bottom-6 right-0 text-[9px] font-mono text-stone-500">
                      {data.cover_width} x {data.cover_height}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center text-stone-500">
                  <BookOpen className="w-16 h-16 opacity-30 mb-2" />
                  <span className="text-xs">No cover available</span>
                </div>
              )}
            </div>

            <div className="px-4 py-3 space-y-2 border-t" style={{ borderColor: "var(--stroke-1)" }}>
              {data.title && (
                <div className="flex items-start gap-2">
                  <span className="text-stone-500 mt-0.5"><BookOpen className="w-3.5 h-3.5" /></span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[9px] uppercase tracking-wider text-stone-500 block">Title</span>
                    <span className="text-[11px] text-stone-200 block truncate" title={data.title}>{data.title}</span>
                  </div>
                </div>
              )}
              {data.author && (
                <div className="flex items-start gap-2">
                  <span className="text-stone-500 mt-0.5"><User className="w-3.5 h-3.5" /></span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[9px] uppercase tracking-wider text-stone-500 block">Author</span>
                    <span className="text-[11px] text-stone-200 block truncate" title={data.author}>{data.author}</span>
                  </div>
                </div>
              )}
              {data.publisher && (
                <div className="flex items-start gap-2">
                  <span className="text-stone-500 mt-0.5"><Building className="w-3.5 h-3.5" /></span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[9px] uppercase tracking-wider text-stone-500 block">Publisher</span>
                    <span className="text-[11px] text-stone-200 block truncate" title={data.publisher}>{data.publisher}</span>
                  </div>
                </div>
              )}
              {data.language && (
                <div className="flex items-start gap-2">
                  <span className="text-stone-500 mt-0.5"><Globe className="w-3.5 h-3.5" /></span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[9px] uppercase tracking-wider text-stone-500 block">Language</span>
                    <span className="text-[11px] text-stone-200 block truncate" title={data.language}>{data.language}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "toc" && (
          <div className="p-3">
            <div className="flex items-center gap-2 mb-3 px-2 text-[10px] text-stone-500">
              <List className="w-3.5 h-3.5" />
              <span>Click on an entry to preview its content</span>
            </div>
            {data.table_of_contents.length > 0 ? (
              <div className="space-y-0.5">
                {data.table_of_contents.map((entry, index) => (
                  <div
                    key={index}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group ${
                      selectedTocIndex === index 
                        ? 'bg-amber-500/20 text-amber-400' 
                        : 'hover:bg-white/5'
                    }`}
                    onClick={() => handleTocClick(index)}
                  >
                    <span className={`transition-colors ${selectedTocIndex === index ? 'text-amber-400' : 'text-stone-500 group-hover:text-stone-300'}`}>
                      {expandedToc.has(index) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </span>
                    <span className={`text-[11px] font-medium truncate flex-1 transition-colors ${
                      selectedTocIndex === index ? 'text-amber-300' : 'text-stone-200 group-hover:text-white'
                    }`} title={entry.title}>
                      {entry.title}
                    </span>
                    {entry.level > 1 && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: "var(--stroke-1)", color: "var(--text-secondary)" }}>
                        L{entry.level}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-stone-500">
                <List className="w-10 h-10 opacity-30 mb-2" />
                <span className="text-xs">No table of contents available</span>
              </div>
            )}
          </div>
        )}

        {activeTab === "preview" && (
          <div className="p-4">
            {previewContent ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-stone-400 pb-2 border-b" style={{ borderColor: "var(--stroke-1)" }}>
                  <FileText className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">{previewContent.title}</span>
                  <span className="text-[9px] font-mono text-stone-500">({previewContent.content.length.toLocaleString()} characters)</span>
                </div>
                <div 
                  ref={previewScrollRef}
                  className="text-[11px] leading-relaxed text-stone-300 whitespace-pre-wrap max-h-[calc(100vh-280px)] overflow-y-auto" 
                  style={{ fontFamily: "Georgia, serif" }}
                >
                  {previewContent.content}
                </div>
              </div>
            ) : data.text_content ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-stone-400 pb-2 border-b" style={{ borderColor: "var(--stroke-1)" }}>
                  <FileText className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">Full Preview</span>
                  <span className="text-[9px] font-mono text-stone-500">({data.text_content.length.toLocaleString()} characters)</span>
                </div>
                <div 
                  ref={previewScrollRef}
                  className="text-[11px] leading-relaxed text-stone-300 whitespace-pre-wrap max-h-[calc(100vh-280px)] overflow-y-auto" 
                  style={{ fontFamily: "Georgia, serif" }}
                >
                  {data.text_content}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-stone-500">
                <FileText className="w-10 h-10 opacity-30 mb-2" />
                <span className="text-xs">No text preview available</span>
                <span className="text-[10px] text-stone-600 mt-1">Click on a chapter in Contents to view its content</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}