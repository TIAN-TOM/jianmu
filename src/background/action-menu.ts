// 工具栏图标的右键菜单：稍后再看粗筛的入口，和播放页卡片、打开就出结论两个开关。
// 勾选状态跟着设置走，设置在别处变了也跟着变。浏览器点击时自己先翻转勾选，改不成就改回设置里的值。
// 没确认启用时两个开关都不改设置，改为打开设置页；打开就出结论还要数据说明的同意齐全，不齐全也改为打开设置页，在那里同意。
// 菜单项的文字跟着设置里的语言（和界面、模型写的内容同一个设置）：语言改了就按新语言重建。
import { inLang, resolveOutputLang, type OutputLang } from "../core/output-lang.ts";
import { MENU_HANT } from "./action-menu-hant.ts";
import { errorLabel, type Log } from "./log.ts";
import { createContextMenus, type ContextMenusDeps } from "../platform/context-menus.ts";
import type { PublicSettings, SettingsStore } from "../platform/settings-store.ts";
import type { Tabs } from "../platform/tabs.ts";
import { dataConsentStatus } from "../shared/consent-status.ts";
import { ACTION_MENU, PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../shared/names.ts";
import { normalize } from "../shared/settings-schema.ts";
import type { StorageChange } from "./routes/appearance.ts";

// 菜单项的文字，中文那份定形状，繁体那份在 action-menu-hant.ts。菜单里放不下设置页那段说明，后果写在标题里：花额度的开关旁要写明。
const MENU_ZH = {
  triage: "稍后再看粗筛",
  inPageCard: "在视频右侧显示总结卡片",
  autoOverview: "打开视频就出结论（花 API 额度）",
};

export type ActionMenuText = typeof MENU_ZH;

const MENU_EN: ActionMenuText = {
  triage: "Watch Later triage",
  inPageCard: "Show summary card beside video",
  autoOverview: "Verdict on open (uses API credit)",
};

/** 指定语言的菜单文字。不传语言时是中文。 */
export const actionMenuText = (lang: OutputLang = "zh"): ActionMenuText => inLang(lang, MENU_ZH, MENU_EN, MENU_HANT);

/** 菜单上的两个开关各自对应的设置项。 */
const SWITCHES = [
  { id: ACTION_MENU.inPageCard, field: "inPageCard" },
  { id: ACTION_MENU.autoOverview, field: "autoOverview" },
] as const;

type SwitchField = (typeof SWITCHES)[number]["field"];

export interface MenuClick {
  readonly menuItemId: string | number;
  /** 点完以后浏览器显示的勾选状态。 */
  readonly checked?: boolean;
}

export type { ContextMenusDeps };

export interface ActionMenuDeps extends ContextMenusDeps {
  readonly settings: Pick<SettingsStore, "loadPublic" | "update" | "activation">;
  readonly tabs: Pick<Tabs, "openPage" | "openOptionsPage">;
  readonly log: Log;
  /** 浏览器的界面语言，语言选「跟随浏览器」时用；不给时按中文。 */
  readonly uiLanguage?: (() => string) | undefined;
}

export interface ActionMenu {
  /** 安装、更新和浏览器启动时建：先清掉建过的再建，勾选按当时的设置，读不到设置按没勾。不往外抛。 */
  readonly build: () => Promise<void>;
  /** 点了菜单里的一项。不是简幕的项不理。不往外抛。 */
  readonly clicked: (info: MenuClick) => Promise<void>;
  /** 存储变了：设置里两个开关的值变了就同步勾选，语言变了就按新语言重建。不往外抛。 */
  readonly settingsChanged: (changes: Readonly<Record<string, StorageChange>>, area: string) => Promise<void>;
}

export function createActionMenu({ settings, tabs, log, uiLanguage = () => "zh", ...deps }: ActionMenuDeps): ActionMenu {
  const menus = createContextMenus(deps);
  const fail = (what: string) => (error: unknown) => void log.error(what, errorLabel(error));
  // 菜单还没建好时改勾选会报错，这时不用管：下次建的时候按设置定。
  const setChecked = (id: string, checked: boolean) => menus.setChecked(id, checked).catch(() => undefined);

  // 几次建排成一队：安装和启动接连来时，前一次清掉、建到一半，后一次再建会撞上同名标识。
  let building: Promise<void> = Promise.resolve();
  const rebuild = () => (building = building.then(build, build));

  async function build() {
    const saved = await settings.loadPublic().catch(() => null);
    const text = actionMenuText(resolveOutputLang(saved?.language ?? "auto", uiLanguage()));
    await menus.removeAll();
    await menus.create({ id: ACTION_MENU.triage, title: text.triage, type: "normal" });
    for (const { id, field } of SWITCHES) {
      await menus.create({ id, title: text[field], type: "checkbox", checked: saved?.[field] === true });
    }
  }

  // 改不成：勾选退回设置里的值，打开设置页让用户在那里处理。
  async function refuse(id: string, saved: PublicSettings | null, field: SwitchField) {
    await setChecked(id, saved?.[field] === true);
    await tabs.openOptionsPage();
  }

  async function toggle(id: string, field: SwitchField, wanted: boolean) {
    const saved = await settings.loadPublic().catch(() => null);
    const enabled = await settings.activation().then(({ state }) => state === "current", () => false);
    if (!saved || !enabled) return refuse(id, saved, field);
    // 打开就出结论和设置页一样：数据说明还要同意或重新同意时不打开。关掉随时可以。
    if (field === "autoOverview" && wanted && dataConsentStatus(saved).state === "needed") return refuse(id, saved, field);
    try {
      await settings.update({ [field]: wanted });
    } catch (error) {
      await setChecked(id, saved[field]);
      throw error;
    }
  }

  async function clicked({ menuItemId, checked }: MenuClick) {
    if (menuItemId === ACTION_MENU.triage) return tabs.openPage(PAGE_PATHS.triage);
    const item = SWITCHES.find(({ id }) => id === menuItemId);
    if (item) await toggle(item.id, item.field, checked === true);
  }

  async function settingsChanged(changes: Readonly<Record<string, StorageChange>>, area: string) {
    const change = area === "local" ? changes[SETTINGS_STORAGE_KEY] : undefined;
    if (!change) return;
    const before = normalize(change.oldValue);
    const after = normalize(change.newValue);
    // 换了语言：整个菜单按新语言重建，勾选也按那时存着的设置定。
    if (before.language !== after.language) return rebuild();
    if (SWITCHES.every(({ field }) => before[field] === after[field])) return;
    // 按现在存着的设置定，不按这次事件带的新值：接连改了几次时，处理晚到的旧事件不会把勾改回去。
    const saved = await settings.loadPublic().catch(() => after);
    for (const { id, field } of SWITCHES) await setChecked(id, saved[field]);
  }

  return {
    build: () => rebuild().catch(fail("建工具栏图标的右键菜单失败")),
    clicked: (info) => clicked(info).catch(fail("处理工具栏图标的右键菜单失败")),
    settingsChanged: (changes, area) => settingsChanged(changes, area).catch(fail("同步右键菜单的勾选失败")),
  };
}
