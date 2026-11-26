// 概览：开始生成、补失败块、读本机已有的概览。生成和补块认领的是先经任务登记的任务，服务核对任务的种类和视频；
// 卡片能开始生成、重新生成和补失败块，只认登记时拿到的一次性令牌，登记时已经过了卡片开关和限频。
// 手动生成或补失败块成功一次，打开就出结论就从额度用完、密钥不对的暂停里恢复。卡片在要经页面读字幕的站（YouTube）上点生成时，
// 任务认领以后先经卡片所在的标签页读到字幕（本机有就不碰页面），读不成就按页面报的原因收尾；侧边栏在那里还没读到字幕时
// 带上视频所在的标签页，走同一条路。
import { fail, type Failure } from "../../core/errors.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { OverviewGetRequest, OverviewResultView, OverviewRetryRequest, OverviewStartRequest } from "../../shared/messages/overview.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { AutoGenerate } from "../services/auto-generate.ts";
import type { OverviewService } from "../services/overview/index.ts";
import type { PageTranscript } from "../services/page-transcript.ts";
import { isVideoKey } from "./validate.ts";

export interface OverviewRouteDeps {
  readonly overview: OverviewService;
  readonly cardLimits: Pick<CardLimits, "redeemToken">;
  readonly auto?: Pick<AutoGenerate, "resume">;
  /** 经页面读字幕的站怎么读；构建里没有代开文字稿面板时没有。 */
  readonly pageTranscript?: PageTranscript | null;
}

type OverviewRoutes = { readonly [K in "overview.start" | "overview.retryFailed" | "overview.get"]: Route<K> };

const MAX_ID = 100;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const onlyKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

const isTabId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isStartRequest(req: unknown): req is OverviewStartRequest {
  if (!isPlainObject(req) || !onlyKeys(req, ["video", "taskId", "token", "fresh", "tabId"]) || !isVideoKey(req.video)) return false;
  if (req.fresh !== undefined && typeof req.fresh !== "boolean") return false;
  if (req.tabId !== undefined && !isTabId(req.tabId)) return false;
  // 任务号和令牌恰好带一个。
  return Object.hasOwn(req, "taskId") ? isId(req.taskId) && !Object.hasOwn(req, "token") : isId(req.token);
}

function isRetryRequest(req: unknown): req is OverviewRetryRequest {
  if (!isPlainObject(req) || !onlyKeys(req, ["video", "taskId", "token"]) || !isVideoKey(req.video)) return false;
  return Object.hasOwn(req, "taskId") ? isId(req.taskId) && !Object.hasOwn(req, "token") : isId(req.token);
}

function isGetRequest(req: unknown): req is OverviewGetRequest {
  return isPlainObject(req) && onlyKeys(req, ["video"]) && isVideoKey(req.video);
}

export function overviewRoutes({ overview, cardLimits, auto, pageTranscript }: OverviewRouteDeps): OverviewRoutes {
  /**
   * 卡片要生成的视频在要经页面读的站上：交给生成的准备步骤，认领任务以后经卡片所在的标签页读到字幕。
   * 读不成时交回页面报的原因：生成时的读取连不上页面，只会报连不上。
   */
  function readInPage(video: VideoKey, tabId: number | undefined): (() => Promise<Failure | null>) | null {
    const ref = parseVideoKey(video);
    const page = pageTranscript;
    if (!ref || ref.platform === "bilibili" || !page || tabId === undefined) return null;
    return async () => {
      const read = await page.read(ref, tabId);
      if ("later" in read) return read.later === "ad" ? fail("PAGE_ACTION_NEEDED", "ad") : read.later === "video-changed" ? fail("VIDEO_CHANGED") : fail("UNAVAILABLE", "no-page");
      return read.ok ? null : fail(read.code, read.detail);
    };
  }
  // 真的拿到了模型的结果才算：本机已有的直接交回、中途停下的（包括结论那一步被停）都不算；补失败块要至少补上一块。
  const resumeAfter = async (pending: ReturnType<OverviewService["generate"]>, succeeded: (value: OverviewResultView) => boolean): ReturnType<OverviewService["generate"]> => {
    const result = await pending;
    if (result.ok && !result.value.canceled && !result.value.verdictCanceled && succeeded(result.value)) await auto?.resume().catch(() => undefined);
    return result;
  };
  const generated = (pending: ReturnType<OverviewService["generate"]>) => resumeAfter(pending, (value) => !value.fromCache);
  const retried = (pending: ReturnType<OverviewService["retryFailed"]>) => resumeAfter(pending, (value) => (value.recoveredChunks ?? 0) > 0);
  return {
    "overview.start": {
      senders: ["panel", "card"],
      validate: isStartRequest,
      async handler(req, { sender }) {
        if (sender.kind === "card") {
          // 卡片不收任务号、不点名标签页：只认登记时换到的令牌，用一次就作废。重新生成在卡片上先确认一次才发。
          if (req.taskId !== undefined || req.token === undefined || req.tabId !== undefined) return fail("FORBIDDEN");
          const taskId = cardLimits.redeemToken(req.token);
          if (!taskId) return fail("TASK_NOT_FOUND");
          const prepare = readInPage(req.video, sender.tabId);
          return generated(overview.generate(taskId, req.video, { fresh: req.fresh === true, ...(prepare ? { prepare } : {}), comments: { tabId: sender.tabId } }));
        }
        if (req.taskId === undefined) return fail("FORBIDDEN");
        // 侧边栏在 YouTube 上还没读到字幕时点生成：和卡片一样，先经视频所在的标签页读到字幕。
        const prepare = req.tabId === undefined ? null : readInPage(req.video, req.tabId);
        return generated(overview.generate(req.taskId, req.video, { fresh: req.fresh === true, ...(prepare ? { prepare } : {}), comments: { tabId: req.tabId } }));
      },
    },
    "overview.retryFailed": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      validate: isRetryRequest,
      handler(req, { sender }) {
        if (sender.kind === "card") {
          if (req.taskId !== undefined || req.token === undefined) return Promise.resolve(fail("FORBIDDEN"));
          const taskId = cardLimits.redeemToken(req.token);
          if (!taskId) return Promise.resolve(fail("TASK_NOT_FOUND"));
          // 和卡片上的生成一样：要经页面读的站，本机的字幕没了就先经卡片所在的标签页读回来再补。
          const prepare = readInPage(req.video, sender.tabId);
          return retried(overview.retryFailed(taskId, req.video, prepare ? { prepare } : {}));
        }
        return req.taskId === undefined ? Promise.resolve(fail("FORBIDDEN")) : retried(overview.retryFailed(req.taskId, req.video));
      },
    },
    "overview.get": {
      senders: ["panel", "page"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isGetRequest,
      handler: (req) => overview.get(req.video),
    },
  };
}
