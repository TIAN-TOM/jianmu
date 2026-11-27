// 要用户另外授权的站（YouTube）：授权在就注册内容脚本，不在就注销。授权本身就是「启用」，设置里不另记一份。
// 主世界的小桥一加载就接播放器取回的字幕，另外要首次启用确认算数才注册：确认前、清除全部数据以后都撤掉，确认以后再补上。
// 只从 app.ts 的构建开关分支引用，开关关着时整个模块不进包。同步一次一次排着做，不交叉。
// 「上一次的状态」看浏览器持久保存的注册：没注册而授权在是新给的，往已开页面补注入；注册着而授权没了是撤掉的，
// 按编号通知全部已开标签页和扩展页面，删掉这个站的观看会话（注销撤不回已经注入的脚本）。安装、更新后浏览器清掉注册，先撤再注册。
import { createSerialQueue } from "../core/concurrency.ts";
import type { Platform } from "../core/video-ref.ts";
import type { Messenger } from "../platform/messaging.ts";
import type { Permissions } from "../platform/permissions.ts";
import type { RegisteredScripts } from "../platform/registered-scripts.ts";
import type { ContentScript, Tabs } from "../platform/tabs.ts";
import type { SiteRules } from "../sites/types.ts";
import type { ContentTabs } from "./content-tabs.ts";
import { errorLabel, type Log } from "./log.ts";

interface SiteScript {
  readonly id: string;
  readonly file: string;
  readonly world?: "MAIN";
  readonly runAt?: "document_start";
  /** 首次启用确认算数时才注册。 */
  readonly afterEnable?: true;
}

// 各站动态注册的内容脚本：编号、产物里的文件，跑在页面主世界的、页面一开始加载就要跑的另外标出来。
const SCRIPTS: Readonly<Partial<Record<Platform, readonly SiteScript[]>>> = {
  youtube: [
    { id: "jianmu-youtube", file: "content/youtube.js" },
    // 小桥：内容脚本问它播放器上已有哪些字幕轨。页面一开始加载就装上，播放器最早取回的字幕也接得住；所以确认启用以后才注册。
    { id: "jianmu-youtube-bridge", file: "content/youtube-bridge.js", world: "MAIN", runAt: "document_start", afterEnable: true },
  ],
};

export interface SiteSwitchDeps {
  readonly rules: readonly SiteRules[];
  readonly permissions: Pick<Permissions, "containsAll">;
  readonly scripts: RegisteredScripts;
  readonly tabs: Pick<Tabs, "tabsMatching" | "inject" | "allTabIds">;
  readonly messenger: Pick<Messenger, "toTabs" | "toPages">;
  readonly contentTabs: Pick<ContentTabs, "list">;
  /** 撤权时删掉这个站的观看会话。 */
  readonly forgetSessions: (platform: Platform) => Promise<void>;
  /** 首次启用确认算不算数：不算数时不按地址查标签页、不补注入。 */
  readonly enabled: () => Promise<boolean>;
  readonly log: Log;
}

export interface SiteSwitch {
  /** 这个站授权了没有。不用另外授权的站一律算授权了。 */
  readonly granted: (platform: Platform) => Promise<boolean>;
  /** 按当前授权和启用确认补上或撤掉注册。fresh：安装、更新以后，原来的注册不一定还在，先撤再注册。 */
  readonly sync: (options?: { readonly fresh?: boolean }) => Promise<void>;
  /** 授权有增减：同步注册，新授权的站往已开页面补注入，撤掉的站通知页面停下。 */
  readonly permissionsChanged: () => Promise<void>;
  /** 授权了的站的内容脚本，补注入和找要通知的页面时和清单里的一起用。 */
  readonly grantedScripts: () => Promise<readonly ContentScript[]>;
  /** 撤了权的站上还有残留的内容脚本发来消息：叫它整套撤下。 */
  readonly retire: (tabId: number, platform: Platform) => Promise<void>;
}

interface OptionalSite {
  readonly rules: SiteRules;
  readonly scripts: readonly SiteScript[];
}

interface Synced {
  readonly site: OptionalSite;
  readonly granted: boolean;
  /** 同步之前就注册着。 */
  readonly present: boolean;
}

export function createSiteSwitch({ rules, permissions, scripts, tabs, messenger, contentTabs, forgetSessions, enabled, log }: SiteSwitchDeps): SiteSwitch {
  const sites: readonly OptionalSite[] = rules.flatMap((rule) => {
    const scripts = SCRIPTS[rule.platform] ?? [];
    return rule.optionalPermission && scripts.length > 0 && rule.permissionOrigins.length > 0 && rule.scriptMatches.length > 0 ? [{ rules: rule, scripts }] : [];
  });
  // 同步排成一条队：刚给就撤这类连着来的事件，后一次看到的是前一次做完的样子。
  const inTurn = createSerialQueue();

  const contentScripts = (site: OptionalSite): ContentScript[] =>
    site.scripts.map(({ file, world }) => ({ matches: site.rules.scriptMatches, js: [file], css: [], allFrames: false, ...(world ? { world } : {}) }));

  async function isGranted(site: OptionalSite): Promise<boolean> {
    try {
      return await permissions.containsAll(site.rules.permissionOrigins);
    } catch (error) {
      log.error("核对站点授权失败", errorLabel(error));
      return false;
    }
  }

  async function syncSite(site: OptionalSite, fresh: boolean): Promise<Synced> {
    const granted = await isGranted(site);
    // 读不到启用状态按没确认算：要确认才注册的那几份宁可先不注册。
    const active = granted && site.scripts.some(({ afterEnable }) => afterEnable) ? await enabled().catch(() => false) : false;
    const wanted = granted ? site.scripts.filter(({ afterEnable }) => !afterEnable || active) : [];
    let present = false;
    try {
      const found = await scripts.registered(site.scripts.map(({ id }) => id));
      present = found.length > 0;
      const stale = fresh ? found : found.filter((id) => !wanted.some((script) => script.id === id));
      if (stale.length > 0) await scripts.unregister(stale);
      const missing = fresh ? wanted : wanted.filter(({ id }) => !found.includes(id));
      for (const { id, file, world, runAt } of missing) await scripts.register({ id, matches: site.rules.scriptMatches, js: [file], ...(world ? { world } : {}), ...(runAt ? { runAt } : {}) });
    } catch (error) {
      log.error("同步站点的内容脚本注册失败", errorLabel(error));
    }
    return { site, granted, present };
  }

  async function injectOpenTabs(site: OptionalSite): Promise<void> {
    try {
      if (!(await enabled())) return;
      const tabIds = await tabs.tabsMatching(site.rules.scriptMatches);
      // 页面正在加载、已经关了或者不让注入都算补不上，刷新页面后由注册接手。
      await Promise.all(tabIds.flatMap((tabId) => contentScripts(site).map((script) => tabs.inject(tabId, script).catch(() => undefined))));
    } catch (error) {
      log.error("往已开的页面补注入失败", errorLabel(error));
    }
  }

  async function revoked(platform: Platform): Promise<void> {
    // 先删观看会话再通知：扩展页面收到通知就重认当前页，会话还在的话又会认出旧视频。
    try {
      await forgetSessions(platform);
    } catch (error) {
      log.error("删掉撤权站点的观看会话失败", errorLabel(error));
    }
    const message = { type: "site.changed", platform, enabled: false } as const;
    // 授权已经没了，不能再按地址找这个站的页面；后台重启过以后内存里登记的又是空的，一直没出声的页面会漏。
    // 所以不按地址筛选查全部已开标签页、只取编号发：别的站的内容脚本不理这个站的撤权，没有内容脚本的标签页收不到也不报错。
    const tabIds = [...new Set([...contentTabs.list(), ...(await tabs.allTabIds())])];
    // 不等页面回话：冻结的标签页要解冻才收消息，等它会拖住这条同步队列，连重新授权也排不上。
    void messenger.toTabs(tabIds, message);
    await messenger.toPages(message);
  }

  const syncAll = (fresh: boolean): Promise<readonly Synced[]> => Promise.all(sites.map((site) => syncSite(site, fresh)));

  return {
    async granted(platform) {
      const site = sites.find((candidate) => candidate.rules.platform === platform);
      if (site) return isGranted(site);
      return !rules.some((rule) => rule.platform === platform && rule.optionalPermission);
    },
    sync: (options) => inTurn(async () => void (await syncAll(options?.fresh === true))),
    permissionsChanged: () =>
      inTurn(async () => {
        for (const { site, granted, present } of await syncAll(false)) {
          if (granted && !present) await injectOpenTabs(site);
          if (!granted && present) await revoked(site.rules.platform);
        }
      }),
    async grantedScripts() {
      const granted = await Promise.all(sites.map(async (site) => ((await isGranted(site)) ? contentScripts(site) : [])));
      return granted.flat();
    },
    async retire(tabId, platform) {
      await messenger.toTabs([tabId], { type: "site.changed", platform, enabled: false });
    },
  };
}
