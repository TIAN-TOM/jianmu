// 要用户另外授权的站（YouTube）：授权在就注册内容脚本，不在就注销。授权本身就是「启用」，设置里不另记一份。
// 只从 app.ts 的构建开关分支引用，开关关着时整个模块不进包。
// 安装、更新后浏览器会清掉动态注册，先撤再注册；浏览器启动和授权增减时按当前授权补上或撤掉。
// 新授权以后往已开的页面补注入一次；撤权以后通知发过消息的页面整套撤下（注销撤不回已经注入的脚本）。
import type { Platform } from "../core/video-ref.ts";
import type { Messenger } from "../platform/messaging.ts";
import type { Permissions } from "../platform/permissions.ts";
import type { RegisteredScripts } from "../platform/registered-scripts.ts";
import type { ContentScript, Tabs } from "../platform/tabs.ts";
import type { SiteRules } from "../sites/types.ts";
import type { ContentTabs } from "./content-tabs.ts";
import { errorLabel, type Log } from "./log.ts";

// 各站动态注册的内容脚本：编号和产物里的文件。
const SCRIPTS: Readonly<Partial<Record<Platform, { readonly id: string; readonly file: string }>>> = {
  youtube: { id: "jianmu-youtube", file: "content/youtube.js" },
};

export interface SiteSwitchDeps {
  readonly rules: readonly SiteRules[];
  readonly permissions: Pick<Permissions, "containsAll">;
  readonly scripts: RegisteredScripts;
  readonly tabs: Pick<Tabs, "tabsMatching" | "inject">;
  readonly messenger: Pick<Messenger, "toTabs">;
  readonly contentTabs: Pick<ContentTabs, "list">;
  /** 首次启用确认算不算数：不算数时不按地址查标签页、不补注入。 */
  readonly enabled: () => Promise<boolean>;
  readonly log: Log;
}

export interface SiteSwitch {
  /** 这个站授权了没有。不用另外授权的站一律算授权了。 */
  readonly granted: (platform: Platform) => Promise<boolean>;
  /** 按当前授权补上或撤掉注册。fresh：安装、更新以后，原来的注册不一定还在，先撤再注册。 */
  readonly sync: (options?: { readonly fresh?: boolean }) => Promise<void>;
  /** 授权有增减：同步注册，新授权的站往已开页面补注入，撤掉的站通知页面停下。 */
  readonly permissionsChanged: () => Promise<void>;
  /** 授权了的站的内容脚本，补注入时和清单里的一起用。 */
  readonly grantedScripts: () => Promise<readonly ContentScript[]>;
}

interface OptionalSite {
  readonly rules: SiteRules;
  readonly id: string;
  readonly file: string;
}

export function createSiteSwitch({ rules, permissions, scripts, tabs, messenger, contentTabs, enabled, log }: SiteSwitchDeps): SiteSwitch {
  const sites: readonly OptionalSite[] = rules.flatMap((rule) => {
    const script = SCRIPTS[rule.platform];
    return rule.optionalPermission && script && rule.permissionOrigins.length > 0 && rule.scriptMatches.length > 0 ? [{ rules: rule, ...script }] : [];
  });
  /** 上一次同步时各站授权在不在，用来分出这次是新给的还是撤掉的。 */
  const lastGranted = new Map<Platform, boolean>();

  const contentScript = (site: OptionalSite): ContentScript => ({ matches: site.rules.scriptMatches, js: [site.file], css: [], allFrames: false });

  async function isGranted(site: OptionalSite): Promise<boolean> {
    try {
      return await permissions.containsAll(site.rules.permissionOrigins);
    } catch (error) {
      log.error("核对站点授权失败", errorLabel(error));
      return false;
    }
  }

  /** 一个站按授权补上或撤掉注册，回这次的授权状态。 */
  async function syncSite(site: OptionalSite, fresh: boolean): Promise<boolean> {
    const granted = await isGranted(site);
    try {
      const present = (await scripts.registered([site.id])).includes(site.id);
      if (present && (fresh || !granted)) await scripts.unregister([site.id]);
      if (granted && (fresh || !present)) await scripts.register({ id: site.id, matches: site.rules.scriptMatches, js: [site.file] });
    } catch (error) {
      log.error("同步站点的内容脚本注册失败", errorLabel(error));
    }
    return granted;
  }

  async function injectOpenTabs(site: OptionalSite): Promise<void> {
    try {
      if (!(await enabled())) return;
      const script = contentScript(site);
      const tabIds = await tabs.tabsMatching(script.matches);
      // 页面正在加载、已经关了或者不让注入都算补不上，刷新页面后由注册接手。
      await Promise.all(tabIds.map((tabId) => tabs.inject(tabId, script).catch(() => undefined)));
    } catch (error) {
      log.error("往已开的页面补注入失败", errorLabel(error));
    }
  }

  async function sync(fresh: boolean): Promise<readonly { readonly site: OptionalSite; readonly granted: boolean; readonly before: boolean | undefined }[]> {
    return Promise.all(
      sites.map(async (site) => {
        const before = lastGranted.get(site.rules.platform);
        const granted = await syncSite(site, fresh);
        lastGranted.set(site.rules.platform, granted);
        return { site, granted, before };
      }),
    );
  }

  return {
    async granted(platform) {
      const site = sites.find((candidate) => candidate.rules.platform === platform);
      if (site) return isGranted(site);
      return !rules.some((rule) => rule.platform === platform && rule.optionalPermission);
    },
    async sync(options) {
      await sync(options?.fresh === true);
    },
    async permissionsChanged() {
      for (const { site, granted, before } of await sync(false)) {
        // 后台刚醒、不知道之前的状态时，授权在就补注入一次：内容脚本自己防重复，多注入一次只是新的接手。
        if (granted && before !== true) await injectOpenTabs(site);
        if (!granted && before !== false) {
          await messenger.toTabs(contentTabs.list(), { type: "site.changed", platform: site.rules.platform, enabled: false });
        }
      }
    },
    async grantedScripts() {
      const granted = await Promise.all(sites.map(async (site) => ((await isGranted(site)) ? [contentScript(site)] : [])));
      return granted.flat();
    },
  };
}
