/**
 * EXRPlayer V2 — shared constants.
 */

export const EXR_OCIO_MODE_STORAGE_KEY = "gk-exr-sequence-ocio-mode";

export const MAX_NATIVE_RESOLUTION = 2048;

export const PLAYBACK_FPS_OPTIONS = [15, 24, 25, 30, 60, 90, 120] as const;

export const OCIO_PASSTHROUGH_MODES = ["Raw", "Linear sRGB"] as const;

export const OCIO_PASSTHROUGH_SLUGS: Readonly<Record<string, string>> = {
  "Raw": "Raw",
  "Linear sRGB": "Linear_sRGB",
};

export const ACES_CONFIGS = ["ACES_1_3_CG"] as const;
export type AcesConfig = (typeof ACES_CONFIGS)[number];

export const PASSTHROUGH_CONFIGS = ["raw", "linear_srgb"] as const;
export type PassthroughConfig = (typeof PASSTHROUGH_CONFIGS)[number];

export type OcioConfigSlug = AcesConfig | PassthroughConfig;

export const LAYER_PRIORITY = [
  "beauty", "combined", "final", "main", "primary",
  "rgb", "rgba", "image", "render", "output",
  "diff", "diffuse", "albedo", "base_color", "basecolor",
  "emission", "emissive", "glow",
  "reflection", "reflect", "specular",
  "transmission", "refraction", "sss",
  "direct", "indirect",
  "shading", "lighting", "light",
  "shadow", "occlusion",
  "normal", "bump",
  "depth", "z",
  "mask", "id", "matte",
] as const;
