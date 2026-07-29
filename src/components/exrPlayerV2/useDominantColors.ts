/**
 * useDominantColors — extract the top-5 dominant colours from the current EXR frame.
 */

import { useCallback } from "react";
import type { ExrState } from "./useExrState";
import { rgbToHex } from "./rgbToHex";
import { rgbToHslString } from "./rgbToHsl";

const DOMINANT_COLOR_COUNT = 5;
const KMEANS_ITERATIONS = 10;
const SAMPLE_STRIDE = 32;

function extractDominantColors(imageData: ImageData): {
  hex: string;
  rgb: string;
  r: number;
  g: number;
  b: number;
}[] {
  const data = imageData.data;
  const pixels: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += SAMPLE_STRIDE * 4) {
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return [];

  let centroids: [number, number, number][] = pixels
    .slice(0, DOMINANT_COLOR_COUNT)
    .map((p) => [...p] as [number, number, number]);
  while (centroids.length < DOMINANT_COLOR_COUNT) centroids.push([0, 0, 0]);

  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    const clusters: [number, number, number][][] = Array.from(
      { length: DOMINANT_COLOR_COUNT },
      () => [],
    );
    for (const px of pixels) {
      let minDist = Infinity;
      let idx = 0;
      for (let c = 0; c < DOMINANT_COLOR_COUNT; c++) {
        const d =
          (px[0] - centroids[c][0]) ** 2 +
          (px[1] - centroids[c][1]) ** 2 +
          (px[2] - centroids[c][2]) ** 2;
        if (d < minDist) {
          minDist = d;
          idx = c;
        }
      }
      clusters[idx].push(px);
    }
    let changed = false;
    for (let c = 0; c < DOMINANT_COLOR_COUNT; c++) {
      if (clusters[c].length === 0) continue;
      const avg: [number, number, number] = [0, 0, 0];
      for (const px of clusters[c]) {
        avg[0] += px[0];
        avg[1] += px[1];
        avg[2] += px[2];
      }
      avg[0] = Math.round(avg[0] / clusters[c].length);
      avg[1] = Math.round(avg[1] / clusters[c].length);
      avg[2] = Math.round(avg[2] / clusters[c].length);
      if (
        avg[0] !== centroids[c][0] ||
        avg[1] !== centroids[c][1] ||
        avg[2] !== centroids[c][2]
      ) {
        changed = true;
      }
      centroids[c] = avg;
    }
    if (!changed) break;
  }

  return centroids.map((c) => ({
    hex: rgbToHex(c[0], c[1], c[2]),
    rgb: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
    hsl: rgbToHslString(c[0], c[1], c[2]),
    r: c[0],
    g: c[1],
    b: c[2],
  }));
}

export function useDominantColors({ state }: { state: ExrState }) {
  return useCallback(() => {
    const canvas = state.colorPickerCanvasRef?.current;
    const imageCanvas = state.imageCanvasRef?.current;
    const bitmap = state.imageBitmap;
    if (!canvas || !imageCanvas || !bitmap) return;

    const colorCtx = canvas.getContext("2d", { willReadFrequently: true });
    if (!colorCtx) return;

    const w = bitmap.width;
    const h = bitmap.height;
    canvas.width = 100;
    canvas.height = Math.round((100 * h) / Math.max(w, 1));
    colorCtx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    try {
      const imageData = colorCtx.getImageData(0, 0, canvas.width, canvas.height);
      const colors = extractDominantColors(imageData);
      state.setDominantColors(colors);
    } catch {
      // cross-origin blocked — leave previous palette in place
    }
  }, [state]);
}
