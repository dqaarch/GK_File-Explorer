import React, { useEffect, useRef } from "react";
import { X, AlertTriangle, Trash2 } from "lucide-react";
import { FSItem } from "../types";

interface DeleteConfirmDialogProps {
  items: FSItem[];
  isPermanent: boolean;
  accentColor: string;
  language: "vi" | "en";
  onConfirm: () => void;
  onCancel: () => void;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.substring(idx + 1) : path;
}

export default function DeleteConfirmDialog({
  items,
  isPermanent,
  accentColor,
  language,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  const itemCount = items.length;
  const isSingle = itemCount === 1;
  const firstName = isSingle ? basename(items[0].path) : null;

  const title = isPermanent
    ? isSingle
      ? t("Xoa vinh vien tep nay?", "Permanently delete this file?")
      : t("Xoa vinh vien " + itemCount + " muc?", "Permanently delete " + itemCount + " items?")
    : isSingle
      ? t("Chuyen tep nay vao Thung rac?", "Move this file to Recycle Bin?")
      : t("Chuyen " + itemCount + " muc vao Thung rac?", "Move " + itemCount + " items to Recycle Bin?");

  const description = isPermanent
    ? isSingle
      ? t("" + firstName + " se bi xoa vinh vien va khong the khoi phuc.", "" + firstName + " will be permanently deleted and cannot be recovered.")
      : t("Cac muc da chon se bi xoa vinh vien va khong the khoi phuc.", "The selected items will be permanently deleted and cannot be recovered.")
    : isSingle
      ? t("" + firstName + " se duoc chuyen vao Thung rac.", "" + firstName + " will be moved to the Recycle Bin.")
      : t("Cac muc da chon se duoc chuyen vao Thung rac.", "The selected items will be moved to the Recycle Bin.");

  const confirmText = isPermanent
    ? t("Xoa vinh vien", "Delete permanently")
    : t("Chuyen vao Thung rac", "Move to Recycle Bin");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative rounded-2xl overflow-hidden shadow-2xl w-[420px] max-w-[90vw] animate-in fade-in zoom-in-95 duration-200 focus:outline-none"
        style={{
          backgroundColor: "var(--surface-bg)",
          border: "1px solid var(--stroke-1)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onConfirm();
          }
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4 border-b"
          style={{ borderColor: "var(--stroke-1)" }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: accentColor + "20" }}
          >
            {isPermanent ? (
              <Trash2 className="w-5 h-5 text-red-400" />
            ) : (
              <AlertTriangle className="w-5 h-5" style={{ color: accentColor }} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2
              className="text-[14px] font-semibold leading-tight"
              style={{ color: "var(--fg-1)" }}
            >
              {title}
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-white/10 shrink-0 cursor-pointer"
            style={{ color: "var(--fg-2)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: "var(--fg-2)" }}
          >
            {description}
          </p>

          {/* Item list preview */}
          {!isSingle && (
            <div
              className="mt-3 p-2.5 rounded-lg max-h-[120px] overflow-y-auto"
              style={{ backgroundColor: "var(--row-bg)" }}
            >
              <div className="flex flex-col gap-1">
                {items.slice(0, 10).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 text-[11px] truncate"
                    style={{ color: "var(--fg-2)" }}
                  >
                    <span style={{ color: "var(--fg-2)" }}>
                      {item.type === "directory" ? "[D]" : "[F]"}
                    </span>
                    <span className="truncate">{basename(item.path)}</span>
                  </div>
                ))}
                {itemCount > 10 && (
                  <div
                    className="text-[11px] italic pt-1"
                    style={{ color: "var(--fg-2)" }}
                  >
                    {t("..." + (itemCount - 10) + " muc khac", "..." + (itemCount - 10) + " more items")}
                  </div>
                )}
              </div>
            </div>
          )}

          {isSingle && (
            <div
              className="mt-3 p-2.5 rounded-lg flex items-center gap-2"
              style={{ backgroundColor: "var(--row-bg)" }}
            >
              <span style={{ color: "var(--fg-2)" }}>
                {items[0].type === "directory" ? "[D]" : "[F]"}
              </span>
              <span
                className="text-[12px] font-medium truncate"
                style={{ color: "var(--fg-1)" }}
              >
                {firstName}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 border-t"
          style={{ borderColor: "var(--stroke-1)" }}
        >
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors hover:bg-white/10 cursor-pointer"
            style={{ color: "var(--fg-2)" }}
          >
            {t("Huy", "Cancel")}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-all hover:opacity-90 cursor-pointer"
            style={{
              backgroundColor: isPermanent ? "#ef4444" : accentColor,
              color: "white",
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}