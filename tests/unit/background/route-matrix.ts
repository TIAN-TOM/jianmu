// 允许矩阵：每条路由和端口收哪些发送方、确认启用之前放不放行。和架构设计第 10.2 节的表是同一张。
// 后台全部路由和端口一次写全，加路由时只照这里实现，不改这里；路由表的逐条测试对照它断言。

export type Site = "bilibili" | "youtube";

export interface MatrixRow {
  readonly name: string;
  readonly port?: true;
  readonly panel: boolean;
  readonly options: boolean;
  readonly triage: boolean;
  /** 卡片：嵌在视频页里的扩展框架。 */
  readonly card: boolean;
  /** 收哪几个站的内容脚本。 */
  readonly content: readonly Site[];
  readonly beforeEnable: boolean;
}

const BOTH: readonly Site[] = ["bilibili", "youtube"];

type Cells = Omit<MatrixRow, "name" | "port">;

const row = (names: readonly string[], cells: Cells, port?: true): MatrixRow[] =>
  names.map((name) => (port ? { name, port, ...cells } : { name, ...cells }));

const PAGES = { panel: true, options: true, triage: true } as const;
const NO_PAGES = { panel: false, options: false, triage: false } as const;
const OPTIONS_ONLY = { panel: false, options: true, triage: false } as const;
const PANEL_ONLY = { panel: true, options: false, triage: false } as const;

/** 认不出的扩展页面一律不放行，所以表里没有这一列。 */
export const ROUTE_MATRIX: readonly MatrixRow[] = [
  ...row(["activation.get"], { ...PAGES, card: false, content: BOTH, beforeEnable: true }),
  ...row(["activation.confirm"], { panel: true, options: true, triage: false, card: false, content: [], beforeEnable: true }),
  ...row(["appearance.get"], { ...PAGES, card: false, content: BOTH, beforeEnable: true }),
  ...row(["options.open"], { ...PAGES, card: true, content: [], beforeEnable: true }),
  ...row(["panel.open"], { panel: false, options: true, triage: true, card: true, content: [], beforeEnable: true }),
  ...row(["config.check"], { ...PAGES, card: true, content: [], beforeEnable: false }),
  ...row(["models.list", "ai.testConnection"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["task.list", "task.cancel", "task.start"], { ...PAGES, card: true, content: [], beforeEnable: false }),
  ...row(["transcript.get"], { ...PAGES, card: true, content: [], beforeEnable: false }),
  ...row(["video.checkAvailable"], { ...PAGES, card: false, content: [], beforeEnable: false }),
  ...row(["imports.add", "imports.remove"], { ...PANEL_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["overview.start"], { ...PANEL_ONLY, card: true, content: [], beforeEnable: false }),
  ...row(["overview.retryFailed", "overview.get"], { ...PAGES, card: false, content: [], beforeEnable: false }),
  ...row(["verdict.fromOfficial"], { ...PANEL_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["qa.ask", "qa.history", "qa.delete", "explain.selection"], { ...PAGES, card: false, content: [], beforeEnable: false }),
  ...row(["translate"], { ...PANEL_ONLY, card: false, content: [], beforeEnable: false }, true),
  ...row(["notes.save", "notes.list", "notes.update", "notes.delete"], { ...PAGES, card: false, content: [], beforeEnable: false }),
  ...row(["notes.saveAtTime"], { ...NO_PAGES, card: false, content: BOTH, beforeEnable: false }),
  ...row(["batch"], { panel: true, options: false, triage: true, card: false, content: [], beforeEnable: false }, true),
  ...row(["triage.state"], { ...PAGES, card: false, content: [], beforeEnable: false }),
  ...row(["playback.info", "playback.milestone"], { ...NO_PAGES, card: false, content: BOTH, beforeEnable: false }),
  ...row(["session.get"], { ...PANEL_ONLY, card: true, content: [], beforeEnable: false }),
  ...row(["session.setMode"], { ...PANEL_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["card.setOverride"], { ...NO_PAGES, card: true, content: [], beforeEnable: false }),
  ...row(["channels.clear"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["grants.release"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: true }),
  ...row(["backup.export"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: true }),
  ...row(["backup.import"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: false }),
  ...row(["data.clear"], { ...OPTIONS_ONLY, card: false, content: [], beforeEnable: true }),
];

/** 路由表里一条路由的放行规则，换成矩阵一行的样子来比。 */
export function rowOf(
  name: string,
  route: { readonly senders: readonly string[]; readonly pages?: readonly string[]; readonly beforeEnable?: true },
): MatrixRow {
  const pages = route.senders.includes("page") ? (route.pages ?? []) : [];
  return {
    name,
    panel: route.senders.includes("panel"),
    options: pages.includes("options"),
    triage: pages.includes("triage"),
    card: route.senders.includes("card"),
    content: BOTH.filter((site) => route.senders.includes(`content:${site}`)),
    beforeEnable: route.beforeEnable === true,
  };
}
