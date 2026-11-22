// B 站字幕轨名字的繁体写法：语言名按 zh-Hant 写，自动生成的轨加后缀。形状由 url.ts 定。模块顶层只放字面量。
import type { TrackNaming } from "./url.ts";

export const TRACK_NAMING_HANT: TrackNaming = { locale: "zh-Hant", autoSuffix: "（自動產生）" };
