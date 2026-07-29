import React, { useState } from "react";
import { ExplorerAPI } from "../useExplorer";
import { 
  FileImage, Settings2, ShieldAlert, ArrowRight, CornerDownRight, Check, Play
} from "lucide-react";

interface BatchImagesModalProps {
  explorer: ExplorerAPI;
  onClose: () => void;
}

export default function BatchImagesModal({ explorer, onClose }: BatchImagesModalProps) {
  const { items, setStatusMessage } = explorer;

  // Image files in current directory
  const imageFiles = items.filter(
    (item) =>
      item.type === "file" &&
      /\.(png|jpg|jpeg|webp|gif|tiff?|tga|exr|bmp|af)$/i.test(item.name)
  );

  // States
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>(
    imageFiles.map(img => img.id)
  );
  
  const [resizePreset, setResizePreset] = useState<"small" | "medium" | "large" | "phone" | "custom">("medium");
  const [customWidth, setCustomWidth] = useState("1925");
  const [customHeight, setCustomHeight] = useState("1080");
  const [onlyShrink, setOnlyShrink] = useState(false);
  const [replaceOriginal, setReplaceOriginal] = useState(false); // If false, create "[Name] (Resized).ext"
  const [outputFormat, setOutputFormat] = useState<"original" | "png" | "jpg" | "webp">("original");

  const toggleSelectFile = (id: string) => {
    setSelectedFileIds(prev => 
      prev.includes(id) ? prev.filter(fId => fId !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    setSelectedFileIds(imageFiles.map(img => img.id));
  };

  const selectNone = () => {
    setSelectedFileIds([]);
  };

  const getPresetDimensions = (preset: typeof resizePreset) => {
    switch (preset) {
      case "small": return { w: 854, h: 480, label: "Small (QD/NTSC)" };
      case "medium": return { w: 1366, h: 768, label: "Medium (Laptop HD)" };
      case "large": return { w: 1920, h: 1080, label: "Large (Full HD 1080p)" };
      case "phone": return { w: 320, h: 568, label: "Phone (Compact Mobile)" };
      case "custom": return { w: parseInt(customWidth) || 1920, h: parseInt(customHeight) || 1080, label: "Custom Size" };
    }
  };

  const handleResizeAction = () => {
    if (selectedFileIds.length === 0) {
      alert(explorer.language === "vi"
        ? "Vui lòng chọn ít nhất một hình ảnh để xử lý!"
        : "Please select at least one image to resize!"
      );
      return;
    }

    setStatusMessage(
      explorer.language === "vi"
        ? "Batch image resize chưa được hỗ trợ trên hệ thống tệp thật."
        : "Batch image resize not yet supported on real filesystem."
    );
    onClose();
  };

  const { w, h } = getPresetDimensions(resizePreset);

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-xs flex items-center justify-center z-[110] animate-in fade-in duration-200">
      <div className="w-[540px] rounded-2xl overflow-hidden shadow-2xl border flex flex-col font-sans transition-colors duration-200 bg-[var(--app-bg)] border-white/10 text-stone-300">
        
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between bg-overlay border-white/5">
          <div className="flex items-center gap-2">
            <FileImage className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-xs tracking-tight">
              {explorer.language === "vi" ? "Batch Images (Image Resizer)" : "Batch Images (PowerToys Resizer)"}
            </span>
          </div>
          <button 
            onClick={onClose}
            className="p-1 px-2.5 rounded text-stone-500 hover:text-white hover:bg-white/5 transition text-xs font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5 flex-1 overflow-y-auto max-h-[70vh] flex flex-col gap-4 text-xs">
          
          {/* File Selection Panel */}
          <div className={`rounded-xl p-3 border flex flex-col gap-2 ${
            "bg-white/5 border-white/5"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[11px] text-stone-400 uppercase tracking-widest">
                {explorer.language === "vi" ? `Phát hiện ${imageFiles.length} ảnh` : `Detected ${imageFiles.length} images`}
              </span>
              <div className="flex gap-2">
                <button 
                  onClick={selectAll} 
                  className="text-[10px] text-sky-400 hover:underline cursor-pointer font-semibold"
                >
                  {explorer.language === "vi" ? "Chọn tất cả" : "Select All"}
                </button>
                <span className="text-stone-600">|</span>
                <button 
                  onClick={selectNone} 
                  className="text-[10px] text-stone-500 hover:underline cursor-pointer"
                >
                  {explorer.language === "vi" ? "Bỏ chọn" : "Select None"}
                </button>
              </div>
            </div>

            {imageFiles.length === 0 ? (
              <div className="py-6 text-center text-stone-500 italic">
                {explorer.language === "vi" 
                  ? "Không tìm thấy tệp hình ảnh nào trong thư mục hiện hành." 
                  : "No image files found in the current folder."}
              </div>
            ) : (
              <div className="max-h-28 overflow-y-auto goku-thin-scroll border border-white/5 rounded-lg p-1.5 flex flex-col gap-1 bg-black/10">
                {imageFiles.map(img => {
                  const isChecked = selectedFileIds.includes(img.id);
                  return (
                    <div 
                      key={img.id}
                      onClick={() => toggleSelectFile(img.id)}
                      className={`flex items-center justify-between p-1.5 px-2 rounded-md cursor-pointer transition ${
                        isChecked 
                          ? ("bg-emerald-500/10 text-emerald-300") 
                          : "hover:bg-white/5 text-stone-400"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <input 
                          type="checkbox" 
                          checked={isChecked}
                          onChange={() => {}} // toggled via parent div click
                          className="rounded text-emerald-500 accent-emerald-500 cursor-pointer"
                        />
                        <span className="truncate">{img.name}</span>
                      </div>
                      <span className="text-[10px] font-mono text-stone-500">
                        {(img.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sizing Profile Preset */}
          <div className="flex flex-col gap-2">
            <span className="font-bold text-[10.5px] uppercase text-stone-400 tracking-wider">
              {explorer.language === "vi" ? "Chọn kích cỡ đích" : "Select Target Dimensions"}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: "small", label: explorer.language === "vi" ? "Nhỏ (854 x 480)" : "Small (854x480)", sub: "480p Web" },
                { key: "medium", label: explorer.language === "vi" ? "Trung bình (1366 x 768)" : "Medium (1366x768)", sub: "Laptop SD" },
                { key: "large", label: explorer.language === "vi" ? "Lớn (1920 x 1080)" : "Large (1920x1080)", sub: "Full HD 1080p" },
                { key: "phone", label: explorer.language === "vi" ? "Điện thoại (320 x 568)" : "Phone (320x568)", sub: "Compact" },
              ].map(opt => (
                <div 
                  key={opt.key}
                  onClick={() => setResizePreset(opt.key as typeof resizePreset)}
                  className={`p-2.5 rounded-xl border cursor-pointer transition flex flex-col gap-0.5 ${
                    resizePreset === opt.key 
                      ? "border-emerald-500 bg-emerald-500/10" 
                      : ("border-white/5 bg-elevated hover:bg-white/5")
                  }`}
                >
                  <span className="font-semibold">{opt.label}</span>
                  <span className="text-[10px] text-stone-500">{opt.sub}</span>
                </div>
              ))}
            </div>

            {/* Custom preset */}
            <div 
              onClick={() => setResizePreset("custom")}
              className={`p-3 rounded-xl border cursor-pointer transition flex flex-col gap-2.5 ${
                resizePreset === "custom" 
                  ? "border-emerald-500 bg-emerald-500/10" 
                  : ("border-white/5 bg-elevated hover:bg-white/5")
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{explorer.language === "vi" ? "Kích thước tuỳ chỉnh" : "Custom Dimensions"}</span>
                <span className="text-[10px] text-stone-500 font-mono">Custom px</span>
              </div>
              {resizePreset === "custom" && (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex-1 flex flex-col gap-1">
                    <label className="text-[9px] text-stone-400">Width (Rộng px)</label>
                    <input 
                      type="number" 
                      value={customWidth}
                      onChange={(e) => setCustomWidth(e.target.value)}
                      className="p-1.5 rounded font-mono text-center text-xs focus:ring-1 focus:ring-emerald-500 bg-overlay border-white/5 text-stone-200"
                    />
                  </div>
                  <span className="text-stone-500 font-bold self-end py-1.5">✕</span>
                  <div className="flex-1 flex flex-col gap-1">
                    <label className="text-[9px] text-stone-400">Height (Cao px)</label>
                    <input 
                      type="number" 
                      value={customHeight}
                      onChange={(e) => setCustomHeight(e.target.value)}
                      className="p-1.5 rounded font-mono text-center text-xs focus:ring-1 focus:ring-emerald-500 bg-overlay border-white/5 text-stone-200"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Options */}
          <div className="flex flex-col gap-2.5">
            <span className="font-bold text-[10.5px] uppercase text-stone-400 tracking-wider">
              {explorer.language === "vi" ? "Tuỳ chọn nâng cao" : "Advanced Options"}
            </span>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input 
                  type="checkbox" 
                  checked={onlyShrink}
                  onChange={(e) => setOnlyShrink(e.target.checked)}
                  className="rounded text-emerald-500 accent-emerald-500 cursor-pointer"
                />
                <span>
                  {explorer.language === "vi" 
                    ? "Chỉ giảm kích thước ảnh (không phóng to ảnh nhỏ)" 
                    : "Only shrink images (do not enlarge smaller images)"}
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input 
                  type="checkbox" 
                  checked={replaceOriginal}
                  onChange={(e) => setReplaceOriginal(e.target.checked)}
                  className="rounded text-emerald-500 accent-emerald-500 cursor-pointer"
                />
                <span className="text-orange-400">
                  {explorer.language === "vi" 
                    ? "Ghi đè tệp gốc (Cảnh báo: Không thể khôi phục!)" 
                    : "Replace original files (Warning: This is destructive!)"}
                </span>
              </label>
            </div>
          </div>

          {/* Output Format */}
          <div className="flex flex-col gap-2">
            <span className="font-bold text-[10.5px] uppercase text-stone-400 tracking-wider">
              {explorer.language === "vi" ? "Định dạng đầu ra" : "Output Format Translation"}
            </span>
            <div className="flex gap-2">
              {["original", "png", "jpg", "webp"].map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setOutputFormat(fmt as typeof outputFormat)}
                  className={`flex-1 py-2 text-center text-[10px] font-bold rounded-lg border cursor-pointer uppercase transition-all duration-150 ${
                    outputFormat === fmt
                      ? "bg-emerald-500 border-emerald-400 text-white shadow-lg shadow-emerald-500/10"
                      : ("bg-elevated border-white/5 text-stone-400 hover:bg-white/5")
                  }`}
                >
                  {fmt === "original" ? (explorer.language === "vi" ? "Giữ nguyên" : "Keep Original") : fmt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Action Panel Footer */}
        <div className={`p-4 border-t flex items-center justify-between ${
          "bg-overlay border-white/10"
        }`}>
          <div className="flex items-center gap-1.5 text-stone-400">
            <Settings2 className="w-3.5 h-3.5" />
            <span>Target: <strong>{w}x{h} px</strong></span>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={onClose}
              className="p-2 px-3.5 rounded-xl border text-[11px] font-bold cursor-pointer transition border-white/5 bg-elevated text-stone-300 hover:bg-white/5"
            >
              {explorer.language === "vi" ? "Huỷ bỏ" : "Cancel"}
            </button>
            <button 
              onClick={handleResizeAction}
              disabled={imageFiles.length === 0 || selectedFileIds.length === 0}
              className={`p-2 px-4 rounded-xl text-[11px] font-bold cursor-pointer transition-all duration-150 flex items-center gap-1.5 select-none ${
                imageFiles.length === 0 || selectedFileIds.length === 0
                  ? "bg-stone-700 text-stone-500 border-transparent cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400 shadow-xl shadow-emerald-600/10"
              }`}
            >
              <Play className="w-3 h-3 fill-current" />
              <span>{explorer.language === "vi" ? "Bắt đầu Resize" : "Start Resize"}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
