import React, { useState, useEffect } from "react";
import { ExplorerAPI } from "../useExplorer";
import { 
  X, Check, Save, RotateCcw, FileCode, Play, Terminal, HelpCircle, 
  BookOpen, Maximize2, Minimize2
} from "lucide-react";

interface EditorProps {
  explorer: ExplorerAPI;
}

export default function FileEditorWindow({ explorer }: EditorProps) {
  const {
    items,
    openFileId,
    openFileContent,
    setOpenFileId,
    updateFileContent
  } = explorer;

  const targetFile = items.find((i) => i.id === openFileId);

  const [editorContent, setEditorContent] = useState("");
  const [isSaved, setIsSaved] = useState(true);
  const [showTauriGuide, setShowTauriGuide] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Load content when a file is selected
  useEffect(() => {
    if (targetFile) {
      setEditorContent(openFileContent || "");
      setIsSaved(true);
    }
  }, [openFileId, targetFile?.id, openFileContent]);

  if (!targetFile) return null;

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditorContent(e.target.value);
    setIsSaved(false);
  };

  const handleSave = () => {
    updateFileContent(targetFile.id, editorContent);
    setIsSaved(true);
    explorer.setStatusMessage(`Đã sao lưu tệp "${targetFile.name}" thành công.`);
  };

  const handleReset = () => {
    if (confirm("Bạn có chắc chắn muốn khôi phục tệp về trạng thái đã lưu gần nhất không?")) {
      setEditorContent(openFileContent || "");
      setIsSaved(true);
    }
  };

  const charCount = editorContent.length;
  const wordCount = editorContent.trim() ? editorContent.trim().split(/\s+/).length : 0;
  const lines = editorContent.split("\n");

  return (
    <div className={`fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-50 p-4 animate-in fade-in duration-200 select-none`}>
      {/* Visual Floating Tauri Native app frame mockup */}
      <div 
        className={`bg-[#17171f] rounded-2xl border border-white/10 shadow-2xl overflow-hidden flex flex-col transition-all duration-300 ${
          fullscreen ? "w-full h-full p-4" : "w-11/12 md:w-3/4 max-w-4xl h-[480px] lg:h-[580px]"
        }`}
      >
        {/* Title Bar styled precisely like a modern Windows window frame */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#111116] border-b border-white/5 shrink-0 text-xs">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-sky-400" />
            <span className="font-semibold text-stone-200">
              Desktop Code Editor - {targetFile.name} {isSaved ? "" : " (Đã chỉnh sửa*)"}
            </span>
            <span className="text-[10px] bg-[#22222b] border border-white/5 text-stone-400 px-2 py-0.5 rounded font-mono select-none">
              Virtual writeback channel active
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Guide panel toggle */}
            <button
              onClick={() => setShowTauriGuide(!showTauriGuide)}
              className="p-1 px-2.5 rounded-md text-stone-400 hover:bg-white/5 hover:text-white flex items-center gap-1 transition cursor-pointer"
              title="Xem cẩm nang lệnh Tauri"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="text-[10px]">Cẩm nang Tauri</span>
            </button>
            <button
              onClick={() => setFullscreen(!fullscreen)}
              className="p-1.5 rounded-md hover:bg-white/5 text-stone-400 hover:text-white transition cursor-pointer"
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setOpenFileId(null)}
              className="p-1 px-2 hover:bg-red-500 hover:text-white text-stone-400 rounded transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content body split (Sidebar + Main editor text area) */}
        <div className="flex-1 flex overflow-hidden min-h-0 bg-[#16161c]">
          {/* Main IDE area */}
          <div className="flex-1 flex min-h-0 overflow-hidden font-mono text-xs text-stone-300">
            {/* Line Counters on the left side */}
            <div className="px-3 bg-[#121217] text-stone-600 select-none py-4 text-right border-r border-white/5 grow-0 text-[11px] font-mono leading-relaxed h-full overflow-hidden shrink-0">
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>

            {/* Editable code text field */}
            <div className="flex-1 h-full min-w-0 bg-[#14141a]">
              <textarea
                value={editorContent}
                onChange={handleTextChange}
                className="w-full h-full p-4 bg-transparent text-stone-100 placeholder-stone-700 outline-none resize-none font-mono text-[12px] leading-relaxed select-text overflow-y-auto"
                placeholder="// Start scripting here..."
                style={{ tabSize: 2 }}
              />
            </div>
          </div>

          {/* Collapsible Developer guide panel for writing Tauri commands! */}
          {showTauriGuide && (
            <div className="w-72 bg-[#121217] border-l border-white/5 p-4 overflow-y-auto shrink-0 select-text font-sans text-stone-300">
              <h4 className="font-semibold text-stone-100 text-xs mb-3 flex items-center gap-1.5 pb-2 border-b border-white/5">
                <HelpCircle className="w-3.5 h-3.5 text-sky-400" />
                <span>Rust & Tauri SDK Help Directives</span>
              </h4>
              <div className="space-y-4 text-[11px] leading-relaxed">
                <div>
                  <p className="font-semibold text-indigo-400 font-mono text-[10px]">1. Invoke Tauri Command from JS</p>
                  <p className="text-stone-400 mt-1">To execute a backend command written in Rust, use the invoke API:</p>
                  <pre className="bg-black/40 p-2 rounded border border-white/5 text-[9px] mt-1.5 font-mono overflow-x-auto text-stone-300">
{`import { invoke } from '@tauri-apps/api/core';

// Execute Rust folder iterator
const res = await invoke('list_files', {
  path: "C:/Projects"
});`}
                  </pre>
                </div>

                <div>
                  <p className="font-semibold text-emerald-400 font-mono text-[10px]">2. Rust backend handler script</p>
                  <p className="text-stone-400 mt-1">Implement commands in `src-tauri/src/main.rs`:</p>
                  <pre className="bg-black/40 p-2 rounded border border-white/5 text-[9px] mt-1.5 font-mono overflow-x-auto text-stone-300">
{`#[tauri::command]
fn list_files(path: String) -> String {
  format!("Files inside {}", path)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![list_files])
    .run(tauri::generate_context!())
    .expect("error while running");
}`}
                  </pre>
                </div>

                <div className="p-2.5 rounded-lg bg-indigo-500/5 border border-indigo-500/10 mt-2 text-[10px] text-indigo-300">
                  <p className="font-semibold flex items-center gap-1.5 text-[11px]">💡 Advanced Customizations</p>
                  <p className="mt-1 leading-normal text-stone-400">Tauri 2 matches native speed because of Tokio event-loops. Our client-side prototype is compatible with all standard Tauri invoke schemas.</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Console info bar & bottom utilities row */}
        <div className="px-4 py-2 bg-[#121217] border-t border-white/5 flex flex-col md:flex-row items-center justify-between shrink-0 gap-2 font-mono text-[10px] select-none text-stone-500">
          <div className="flex items-center gap-3">
            <span>Size: {charCount} characters</span>
            <span className="hidden md:inline">|</span>
            <span>Words: {wordCount} words</span>
            <span className="hidden md:inline">|</span>
            <span>Lines: {lines.length} lines</span>
          </div>

          <div className="flex items-center gap-2">
            {!isSaved && (
              <span className="text-amber-500 text-[9px] bg-amber-500/5 px-2 py-0.5 border border-amber-500/15 rounded-lg flex items-center gap-1">
                Tệp chưa được đồng bộ lưu ý
              </span>
            )}
            <button
              onClick={handleReset}
              className="flex items-center gap-1 px-3 py-1 bg-white/5 border border-white/10 text-stone-300 rounded-lg hover:bg-white/10 active:bg-white/15 transition pr-3 pb-1 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Khôi phục</span>
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-1 px-3 py-1 bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 rounded-lg hover:bg-emerald-500/20 active:bg-emerald-500/25 transition pr-3 pb-1 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Lưu thay đổi</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
