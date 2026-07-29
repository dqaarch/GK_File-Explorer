import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, FileSpreadsheet } from "lucide-react";

interface XLSXPreviewProps {
  filePath: string;
  fileName: string;
  accentColor?: string;
}

interface SheetData {
  name: string;
  data: (string | number | boolean | null)[][];
  maxCols: number;
}

export default function XLSXPreview({ filePath, fileName, accentColor = "#ea580c" }: XLSXPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    if (!filePath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadXlsx = async () => {
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

        // Parse workbook
        const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: true });

        // Extract sheets data
        const sheetsData: SheetData[] = workbook.SheetNames.map((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
          const data = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
            header: 1,
            defval: null,
            raw: false,
          }) as (string | number | boolean | null)[][];

          return {
            name: sheetName,
            data,
            maxCols: range.e.c + 1,
          };
        });

        if (!cancelled) {
          setSheets(sheetsData);
          setActiveSheet(0);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to render XLSX:", err);
          setError(String(err));
          setLoading(false);
        }
      }
    };

    void loadXlsx();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const renderCell = (value: string | number | boolean | null, rowIndex: number, colIndex: number) => {
    if (value === null || value === undefined) {
      return null;
    }

    const isHeader = rowIndex === 0;
    const isNumber = typeof value === "number";
    const isBoolean = typeof value === "boolean";

    return (
      <td
        key={colIndex}
        className={`
          px-2 py-1 border border-gray-200
          ${isHeader ? "bg-gray-100 font-semibold" : "bg-white"}
          ${isNumber ? "text-right font-mono" : ""}
          ${isBoolean ? "text-center" : ""}
        `}
        style={{ color: "#000000" }}
      >
        {isBoolean ? (value ? "TRUE" : "FALSE") : String(value)}
      </td>
    );
  };

  const currentSheet = sheets[activeSheet];

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
        <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
        <span className="text-xs font-semibold truncate flex-1" title={fileName} style={{ color: "#000000" }}>
          {fileName}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "#000000" }}>XLSX</span>
      </div>

      {/* Sheet Tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 bg-gray-50 overflow-x-auto shrink-0">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              onClick={() => setActiveSheet(index)}
              className={`
                px-3 py-1 text-[10px] font-semibold rounded whitespace-nowrap transition-colors
                ${activeSheet === index
                  ? "bg-emerald-500 text-white"
                  : "bg-gray-200 hover:bg-gray-300"
                }
              `}
              style={{ color: activeSheet === index ? undefined : "#000000" }}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
              <span className="text-xs" style={{ color: "#000000" }}>Loading spreadsheet...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
            <div className="flex flex-col items-center gap-2 text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <span className="text-sm font-medium text-red-600">Failed to load spreadsheet</span>
              <span className="text-xs max-w-[250px] break-all" style={{ color: "#000000" }}>{error}</span>
            </div>
          </div>
        )}

        {currentSheet && !loading && (
          <div className="p-2 overflow-auto">
            {/* Sheet name */}
            <div className="px-2 py-1.5 mb-2 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#000000" }}>
                {currentSheet.name}
              </span>
              <span className="text-[9px]" style={{ color: "#000000" }}>
                ({currentSheet.data.length} rows, {currentSheet.maxCols} columns)
              </span>
            </div>

            {/* Table */}
            {currentSheet.data.length > 0 ? (
              <table className="border-collapse w-full text-[11px]">
                <tbody>
                  {currentSheet.data.map((row, rowIndex) => (
                    <tr key={rowIndex} className={rowIndex % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                      {/* Row number */}
                      <td className="w-8 px-1 py-1 border border-gray-200 bg-gray-100 text-[9px] text-center font-mono sticky left-0 z-[1]" style={{ color: "#000000" }}>
                        {rowIndex + 1}
                      </td>
                      {/* Data cells */}
                      {Array.from({ length: Math.max(currentSheet.maxCols, 1) }).map((_, colIndex) => (
                        <React.Fragment key={colIndex}>{renderCell(row[colIndex] ?? null, rowIndex, colIndex)}</React.Fragment>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-center text-xs py-8" style={{ color: "#000000" }}>Empty sheet</div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      {currentSheet && !loading && (
        <div className="px-3 py-1.5 border-t border-gray-200 bg-gray-50 flex items-center gap-4 text-[9px] shrink-0" style={{ color: "#000000" }}>
          <span>
            Sheet: <span className="font-semibold">{currentSheet.name}</span>
          </span>
          <span>
            Rows: <span className="font-semibold">{currentSheet.data.length}</span>
          </span>
          <span>
            Columns: <span className="font-semibold">{currentSheet.maxCols}</span>
          </span>
          <span>
            Sheets: <span className="font-semibold">{sheets.length}</span>
          </span>
        </div>
      )}
    </div>
  );
}
