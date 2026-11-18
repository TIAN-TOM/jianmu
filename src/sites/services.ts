// 后台用的服务注册表：每个站一份读取服务、一份退避，第一次用到时才建，模块加载时不碰扩展接口。
import type { Platform } from "../core/video-ref.ts";
import { createSiteBackoff } from "../platform/site-backoff.ts";
import { extensionStorage } from "../platform/storage.ts";
import { createBilibiliService } from "./bilibili/service.ts";
import type { PageChannel, SiteBackoff, SiteCtx, SiteService } from "./types.ts";
import { createYoutubeService } from "./youtube/service.ts";

// YouTube 的读取服务只在构建开关打开时登记，关着时整个读取实现不进包。
const FACTORIES: Readonly<Partial<Record<Platform, () => SiteService>>> = FEATURE_YOUTUBE
  ? { bilibili: createBilibiliService, youtube: createYoutubeService }
  : { bilibili: createBilibiliService };

const services = new Map<Platform, SiteService>();
const backoffs = new Map<Platform, SiteBackoff>();

/** 这个站的读取服务，每次是同一个实例：签名密钥、字幕列表记录和在途请求都在它里面。还没接上的站是 undefined。 */
export function siteService(platform: Platform): SiteService | undefined {
  const existing = services.get(platform);
  if (existing) return existing;
  const created = FACTORIES[platform]?.();
  if (created) services.set(platform, created);
  return created;
}

function siteBackoff(platform: Platform): SiteBackoff {
  const existing = backoffs.get(platform);
  if (existing) return existing;
  const created = createSiteBackoff({ site: platform, session: extensionStorage().session });
  backoffs.set(platform, created);
  return created;
}

/**
 * 一次读取操作用的环境，每次新建：已登录的结论只在这次操作里沿用。退避同站共用：令牌桶在内存里，各算各的等于没有限速。
 * 要在页面里读的站，调用方给了标签页时带上通往那个标签页的通道。
 */
export function createSiteCtx(platform: Platform, signal: AbortSignal, page?: PageChannel): SiteCtx {
  // 不绑定时，以方法形式调用会报错。
  return { fetch: fetch.bind(globalThis), signal, backoff: siteBackoff(platform), ...(page ? { page } : {}) };
}
