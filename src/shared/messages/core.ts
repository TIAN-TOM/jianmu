// 启用、外观和打开页面这几条消息的请求和回复。
import type { ActivationKind, NoticeStatus } from "../../core/consent.ts";
import type { AccentTheme } from "../settings-schema.ts";

/** 不带参数的请求。 */
export type EmptyRequest = Readonly<Record<string, never>>;

/** 内容脚本读不到存储，外观和卡片开关只能经这条消息拿。 */
export interface AppearanceView {
  readonly accentTheme: AccentTheme;
  readonly inPageCard: boolean;
}

/** 打开侧边栏被浏览器拒绝时，页面改口提示用户点工具栏图标。 */
export type PanelOpenReply = { readonly opened: true } | { readonly opened: false; readonly needsToolbarClick: true };

/** 确认启用的回复，另带补注入没补上的标签页：侧边栏在这些页面上提示刷新。 */
export type ActivationConfirmReply = NoticeStatus<ActivationKind> & { readonly unreachableTabs: readonly number[] };

export interface CoreApi {
  "activation.get": { req: EmptyRequest; res: NoticeStatus<ActivationKind> };
  "activation.confirm": { req: EmptyRequest; res: ActivationConfirmReply };
  "appearance.get": { req: EmptyRequest; res: AppearanceView };
  "options.open": { req: EmptyRequest; res: EmptyRequest };
  "panel.open": { req: EmptyRequest; res: PanelOpenReply };
}
