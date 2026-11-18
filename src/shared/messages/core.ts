// 启用、外观、打开页面和构建标识这几条消息的请求和回复。
import type { ActivationKind, NoticeStatus } from "../../core/consent.ts";
import type { AccentTheme } from "../settings-schema.ts";

/** 不带参数的请求。 */
export type EmptyRequest = Readonly<Record<string, never>>;

/** 内容脚本读不到存储，外观和卡片开关只能经这条消息拿。 */
export interface AppearanceView {
  readonly accentTheme: AccentTheme;
  readonly inPageCard: boolean;
}

/** 打开设置页时可以直接滚到的几节，值是设置页里那一节的 id。 */
export const OPTIONS_SECTIONS = ["ai-service", "youtube"] as const;
export type OptionsSection = (typeof OPTIONS_SECTIONS)[number];

export function isOptionsSection(value: unknown): value is OptionsSection {
  return (OPTIONS_SECTIONS as readonly unknown[]).includes(value);
}

/** 不带节名时按浏览器默认的方式打开设置页；带了就打开或切到设置页，滚到那一节。 */
export type OptionsOpenRequest = EmptyRequest | { readonly section: OptionsSection };

/** 打开侧边栏被浏览器拒绝时，页面改口提示用户点工具栏图标。 */
export type PanelOpenReply = { readonly opened: true } | { readonly opened: false; readonly needsToolbarClick: true };

/** 确认启用的回复，另带补注入没补上的标签页：侧边栏在这些页面上提示刷新。 */
export type ActivationConfirmReply = NoticeStatus<ActivationKind> & { readonly unreachableTabs: readonly number[] };

/** 后台这次构建的标识，页面拿来和自己的比。 */
export interface BuildView {
  readonly build: string;
}

export interface CoreApi {
  "build.id": { req: EmptyRequest; res: BuildView };
  "activation.get": { req: EmptyRequest; res: NoticeStatus<ActivationKind> };
  "activation.confirm": { req: EmptyRequest; res: ActivationConfirmReply };
  "appearance.get": { req: EmptyRequest; res: AppearanceView };
  "options.open": { req: OptionsOpenRequest; res: EmptyRequest };
  "panel.open": { req: EmptyRequest; res: PanelOpenReply };
}
