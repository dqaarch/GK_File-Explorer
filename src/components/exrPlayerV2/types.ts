/**
 * EXRPlayer V2 — shared types.
 */

import type { MediaInfo } from "../../utils/fileTypeDetector";
import type { ExrLayerInfo, OcioConfigGroup, OcioModeInfo } from "../../TauriFileSystem";

export type ChannelMode = "RGB" | "R" | "G" | "B" | "A" | "Y";

export type PlaybackFPS = 15 | 24 | 25 | 30 | 60 | 90 | 120;

export interface ColorInfo {
  hex: string;
  rgb: string;
  r?: number;
  g?: number;
  b?: number;
  hsl?: string;
}

export interface FrameMetadata {
  width?: number;
  height?: number;
  channels?: string[];
  method?: string;
}

export interface FrameStatus {
  frameIndex: number;
  status: "loaded" | "loading" | "pending" | "error";
}

export interface ExrPlayerProps {
  fileName: string;
  filePath: string;
  mediaInfo: MediaInfo;
  accentColor?: string;
  onClose?: () => void;
  fileFingerprint?: string;
  language?: "vi" | "en";
  theme?: "dark" | "light" | "mono";
}

export type { ExrLayerInfo, OcioConfigGroup, OcioModeInfo };
