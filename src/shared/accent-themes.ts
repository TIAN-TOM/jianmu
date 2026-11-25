// 五套主题的 id、顺序和脚本要用的几个颜色，设置模块原样转出。

interface ThemeColors {
  readonly bg: string;
  readonly card: string;
  readonly text: string;
  readonly accent: string;
}

// 主题的名字和一句话说明在设置页的文案表里，按 id 取。
interface AccentThemeInfo {
  /** 这套主题的标志色：设置页选项前面的色块，也是播放页悬停按钮亮起来时的底色，上面是 onSwatch 色的图标和字。 */
  readonly swatch: string;
  /** 标志色上面的字和图标的颜色，配标志色过 4.5:1。 */
  readonly onSwatch: string;
  /** 设置页主题卡片上的小预览，明暗各一组。 */
  readonly preview: { readonly light: ThemeColors; readonly dark: ThemeColors };
}

// 五套完整配色，按设置页的排列顺序写。完整色值在主题样式表里，按 html 的 data 属性切换，这里只留脚本要用的颜色，两边要一致。
export const ACCENT_THEMES = Object.freeze({
  timecode: {
    swatch: "#d3382c",
    onSwatch: "#ffffff",
    preview: {
      light: { bg: "#eef0f3", card: "#ffffff", text: "#15171c", accent: "#15171c" },
      dark: { bg: "#242830", card: "#1b1e24", text: "#e8eaee", accent: "#e8eaee" },
    },
  },
  marker: {
    swatch: "#0969da",
    onSwatch: "#ffffff",
    preview: {
      light: { bg: "#ffffff", card: "#ffffff", text: "#1f2328", accent: "#0969da" },
      dark: { bg: "#0d1117", card: "#0d1117", text: "#f0f6fc", accent: "#4493f8" },
    },
  },
  band: {
    swatch: "#4c4f69",
    onSwatch: "#ffffff",
    preview: {
      light: { bg: "#e6e9ef", card: "#eff1f5", text: "#4c4f69", accent: "#4c4f69" },
      dark: { bg: "#181825", card: "#1e1e2e", text: "#cdd6f4", accent: "#cdd6f4" },
    },
  },
  pinkblue: {
    swatch: "#ad1c5b",
    onSwatch: "#ffffff",
    preview: {
      light: { bg: "#f1f2f3", card: "#ffffff", text: "#18191c", accent: "#00699d" },
      dark: { bg: "#0a0b0c", card: "#17181a", text: "#e7e9eb", accent: "#58b1d4" },
    },
  },
  redblack: {
    swatch: "#ff0033",
    onSwatch: "#0f0f0f",
    preview: {
      light: { bg: "#ffffff", card: "#ffffff", text: "#0f0f0f", accent: "#0f0f0f" },
      dark: { bg: "#0f0f0f", card: "#212121", text: "#f1f1f1", accent: "#f1f1f1" },
    },
  },
} as const satisfies Readonly<Record<string, AccentThemeInfo>>);
export type AccentTheme = keyof typeof ACCENT_THEMES;
