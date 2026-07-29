import { useCallback } from "react";
import { ThemeColors, ThemeType, themeColors, getThemeColors } from "./colors";

export interface UseThemeColorsReturn {
  colors: ThemeColors;
  theme: ThemeType;
  isDark: boolean;
  isLight: boolean;
  isMono: boolean;
  getBg: (level: 1 | 2 | 3 | 4 | 5 | 6) => string;
  getFg: (level: 1 | 2 | 3 | "disabled") => string;
  getStroke: (level: 1 | 2 | 3) => string;
  getAccent: (state?: "primary" | "hover" | "pressed") => string;
}

/**
 * Hook to access theme colors with helpers
 */
export function useThemeColors(theme: ThemeType): UseThemeColorsReturn {
  const colors = getThemeColors(theme);

  const getBg = useCallback((level: 1 | 2 | 3 | 4 | 5 | 6): string => {
    const bgMap = {
      1: colors.background.bg1,
      2: colors.background.bg2,
      3: colors.background.bg3,
      4: colors.background.bg4,
      5: colors.background.bg5,
      6: colors.background.bg6,
    };
    return bgMap[level];
  }, [colors]);

  const getFg = useCallback((level: 1 | 2 | 3 | "disabled"): string => {
    const fgMap = {
      1: colors.foreground.fg1,
      2: colors.foreground.fg2,
      3: colors.foreground.fg3,
      disabled: colors.foreground.fgDisabled,
    };
    return fgMap[level];
  }, [colors]);

  const getStroke = useCallback((level: 1 | 2 | 3): string => {
    const strokeMap = {
      1: colors.stroke.stroke1,
      2: colors.stroke.stroke2,
      3: colors.stroke.stroke3,
    };
    return strokeMap[level];
  }, [colors]);

  const getAccent = useCallback((state: "primary" | "hover" | "pressed" = "primary"): string => {
    const accentMap = {
      primary: colors.accent.primary,
      hover: colors.accent.hover,
      pressed: colors.accent.pressed,
    };
    return accentMap[state];
  }, [colors]);

  return {
    colors,
    theme,
    isDark: theme === "dark",
    isLight: theme === "light",
    isMono: theme === "mono",
    getBg,
    getFg,
    getStroke,
    getAccent,
  };
}

export { themeColors, getThemeColors };
export type { ThemeColors, ThemeType } from "./colors";
