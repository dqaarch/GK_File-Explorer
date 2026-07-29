export function normalizeThumbnailSrc(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}
