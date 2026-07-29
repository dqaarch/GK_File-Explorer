/**
 * Windows 11 File Explorer Color System
 * Based on Fluent UI Design Tokens
 */

export type ThemeType = "dark" | "light" | "mono";

// Neutral Backgrounds - 6 levels from lightest to darkest
export interface NeutralBackgrounds {
  bg1: string;  // Base layer - App shell
  bg2: string;  // Secondary - Sidebar, panels
  bg3: string;  // Tertiary - Cards, elevated
  bg4: string;  // Deep - Dropdowns, popovers
  bg5: string;  // Deepest - Media viewer
  bg6: string;  // Hover surface
}

// Neutral Foregrounds (Text)
export interface NeutralForegrounds {
  fg1: string;  // Primary text
  fg2: string;  // Secondary text
  fg3: string;  // Tertiary/muted text
  fgDisabled: string;  // Disabled text
}

// Stroke/Border Colors
export interface StrokeColors {
  stroke1: string;  // Default borders
  stroke2: string;  // Subtle dividers
  stroke3: string;  // Disabled borders
}

// Interaction State Colors
export interface InteractionColors {
  hover: string;
  pressed: string;
  selected: string;
  disabled: string;
}

// Accent Colors
export interface AccentColors {
  primary: string;
  hover: string;
  pressed: string;
}

// Complete Theme Colors
export interface ThemeColors {
  background: NeutralBackgrounds;
  foreground: NeutralForegrounds;
  stroke: StrokeColors;
  interaction: InteractionColors;
  accent: AccentColors;
  // Checkerboard for image/video preview
  checkerboard: {
    primary: string;
    secondary: string;
  };
}

const darkColors: ThemeColors = {
  background: {
    bg1: "#292929",   // Base - App shell
    bg2: "#1f1f1f",   // Sidebar, panels
    bg3: "#141414",   // Cards, elevated surfaces
    bg4: "#0a0a0a",   // Dropdowns, popovers
    bg5: "#000000",   // Media viewer (darkest)
    bg6: "#3d3d3d",   // Hover surface
  },
  foreground: {
    fg1: "#ffffff",           // Primary text
    fg2: "#d4d4d8",           // Secondary text
    fg3: "#a1a1aa",           // Tertiary/muted
    fgDisabled: "#52525b",    // Disabled
  },
  stroke: {
    stroke1: "#3f3f46",       // Default borders
    stroke2: "#52525b",       // Subtle dividers
    stroke3: "#71717a",       // Disabled borders
  },
  interaction: {
    hover: "#3d3d3d",
    pressed: "#1f1f1f",
    selected: "#383838",
    disabled: "#1a1a1a",
  },
  accent: {
    primary: "#60cdff",       // Windows 11 Blue
    hover: "#8ad4ff",
    pressed: "#4bc1ff",
  },
  checkerboard: {
    primary: "#1a1a1a",
    secondary: "#252525",
  },
};

const lightColors: ThemeColors = {
  background: {
    bg1: "#ffffff",           // Base - App shell
    bg2: "#fafafa",           // Sidebar, panels
    bg3: "#f4f4f5",           // Cards, elevated
    bg4: "#e4e4e7",           // Dropdowns
    bg5: "#d4d4d8",           // Media viewer
    bg6: "#e8e8e8",           // Hover surface
  },
  foreground: {
    fg1: "#1a1a1a",           // Primary text
    fg2: "#52525b",           // Secondary text
    fg3: "#71717a",           // Tertiary
    fgDisabled: "#a1a1aa",    // Disabled
  },
  stroke: {
    stroke1: "#d4d4d8",       // Default borders
    stroke2: "#e4e4e7",       // Subtle dividers
    stroke3: "#f4f4f5",       // Disabled borders
  },
  interaction: {
    hover: "#f4f4f5",
    pressed: "#e4e4e7",
    selected: "#e4e4e7",
    disabled: "#fafafa",
  },
  accent: {
    primary: "#0078d4",       // Windows Blue
    hover: "#106ebe",
    pressed: "#005a9e",
  },
  checkerboard: {
    primary: "#e5e5e5",
    secondary: "#f0f0f0",
  },
};

const monoColors: ThemeColors = {
  background: {
    bg1: "#1a1a1a",           // Base - slightly lighter than dark
    bg2: "#141414",            // Sidebar
    bg3: "#0f0f0f",            // Cards
    bg4: "#0a0a0a",            // Dropdowns
    bg5: "#000000",            // Media viewer
    bg6: "#252525",            // Hover
  },
  foreground: {
    fg1: "#e5e5e5",           // Primary text (less contrast)
    fg2: "#a8a8a8",           // Secondary
    fg3: "#707070",            // Tertiary
    fgDisabled: "#404040",     // Disabled
  },
  stroke: {
    stroke1: "#2d2d2d",
    stroke2: "#3a3a3a",
    stroke3: "#4a4a4a",
  },
  interaction: {
    hover: "#252525",
    pressed: "#141414",
    selected: "#1f1f1f",
    disabled: "#0f0f0f",
  },
  accent: {
    primary: "#888888",        // Neutral accent
    hover: "#999999",
    pressed: "#777777",
  },
  checkerboard: {
    primary: "#1a1a1a",
    secondary: "#222222",
  },
};

export const themeColors: Record<ThemeType, ThemeColors> = {
  dark: darkColors,
  light: lightColors,
  mono: monoColors,
};

export function getThemeColors(theme: ThemeType): ThemeColors {
  return themeColors[theme];
}

// CSS variable names for use in styles
export const cssVarNames = {
  background: {
    bg1: "--bg-1",
    bg2: "--bg-2",
    bg3: "--bg-3",
    bg4: "--bg-4",
    bg5: "--bg-5",
    bg6: "--bg-6",
  },
  foreground: {
    fg1: "--fg-1",
    fg2: "--fg-2",
    fg3: "--fg-3",
    fgDisabled: "--fg-disabled",
  },
  stroke: {
    stroke1: "--stroke-1",
    stroke2: "--stroke-2",
    stroke3: "--stroke-3",
  },
  accent: {
    primary: "--accent-primary",
    hover: "--accent-hover",
    pressed: "--accent-pressed",
  },
  checkerboard: {
    primary: "--checkerboard-primary",
    secondary: "--checkerboard-secondary",
  },
};
