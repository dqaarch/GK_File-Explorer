import React, { useState, useEffect, useRef } from "react";
import { X, FolderPlus, FilePlus, Link } from "lucide-react";

interface NewItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "folder" | "file" | "shortcut";
  language: "vi" | "en";
  defaultName?: string;
  currentPath?: string;
  onCreate: (name: string) => void;
}

export default function NewItemModal({
  isOpen,
  onClose,
  mode,
  language,
  defaultName,
  currentPath,
  onCreate,
}: NewItemModalProps) {
  const [name, setName] = useState(defaultName || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(defaultName || "");
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [isOpen, defaultName]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  const labels = {
    folder: {
      title: language === "vi" ? "Tạo thư mục mới" : "Create New Folder",
      namePlaceholder: language === "vi" ? "Tên thư mục..." : "Folder name...",
      defaultVal: language === "vi" ? "Thư mục mới" : "New Folder",
      create: language === "vi" ? "Tạo thư mục" : "Create Folder",
      icon: FolderPlus,
      iconColor: "text-amber-400",
    },
    file: {
      title: language === "vi" ? "Tạo tệp văn bản mới" : "Create New Text File",
      namePlaceholder: language === "vi" ? "Tên tệp..." : "File name...",
      defaultVal: language === "vi" ? "ghi_chu.txt" : "notes.txt",
      create: language === "vi" ? "Tạo tệp" : "Create File",
      icon: FilePlus,
      iconColor: "text-sky-400",
    },
    shortcut: {
      title: language === "vi" ? "Tạo lối tắt mới" : "Create New Shortcut",
      namePlaceholder: language === "vi" ? "Tên lối tắt..." : "Shortcut name...",
      defaultVal: language === "vi" ? "Lối tắt mới" : "New Shortcut",
      create: language === "vi" ? "Tạo lối tắt" : "Create Shortcut",
      icon: Link,
      iconColor: "text-teal-400",
    },
  };

  const lbl = labels[mode];
  const Icon = lbl.icon;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let finalName = name.trim();
    if (!finalName) return;
    if (mode === "file" && !finalName.endsWith(".txt")) {
      finalName += ".txt";
    }
    if (mode === "shortcut" && !finalName.endsWith(".lnk")) {
      finalName += ".lnk";
    }
    onCreate(finalName);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Modal */}
      <div
        className="relative w-full max-w-sm mx-4 rounded-2xl border border-white/10 shadow-2xl overflow-hidden pointer-events-auto"
        style={{ backgroundColor: "var(--app-bg)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg bg-white/5`}>
              <Icon className={`w-4 h-4 ${lbl.iconColor}`} />
            </div>
            <span className="text-sm font-semibold text-stone-200">{lbl.title}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/10 text-stone-500 hover:text-stone-300 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-5 py-5">
          <div className="mb-1">
            <label className="block text-[10px] font-semibold text-stone-500 uppercase tracking-wider mb-2">
              {language === "vi" ? "Tên" : "Name"}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={lbl.defaultVal}
              className="w-full px-3 py-2.5 rounded-xl text-sm text-stone-200 placeholder-stone-600 focus:outline-none focus:border-white/25 transition"
              style={{ backgroundColor: "var(--surface-bg)", border: "1px solid rgba(255,255,255,0.1)" }}
              autoFocus
            />
          </div>

          {mode === "shortcut" && currentPath && (
            <div className="mt-3">
              <label className="block text-[10px] font-semibold text-stone-500 uppercase tracking-wider mb-2">
                {language === "vi" ? "Đường dẫn đích" : "Target Path"}
              </label>
              <div className="px-3 py-2 rounded-xl text-[11px] text-stone-500 font-mono truncate" style={{ backgroundColor: "var(--surface-bg)" }}>
                {currentPath}
              </div>
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs text-stone-400 hover:text-stone-200 hover:bg-white/5 transition cursor-pointer"
          >
            {language === "vi" ? "Hủy" : "Cancel"}
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-white/10 text-stone-200 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)" }}
          >
            {lbl.create}
          </button>
        </div>
      </div>
    </div>
  );
}
