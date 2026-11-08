// 选好字幕轨以后按顺序下载字幕文件。候选一条条试，不并发：同时向一个文件主机发好几个请求，碰上限流反而一起失败。
// 只坏一个文件的（空文件、读取被拒、读不懂）照旧试下一条；超时、被限流、要登录这些换一条也一样，直接停。
// 一次读取的所有下载共用一份总预算（点名语言时重新列轨后的那轮也算在内），从第一次下载开始算，
// 到点中止这次读取的环境，剩不到 1 秒就不再开始新的一条。
import { fail, type Failure } from "../../../core/errors.ts";
import type { CaptionTrack, Cue, SiteCtx, SiteResult, SiteService, VideoInfo } from "../../../sites/types.ts";
import type { Timers } from "../../tasks.ts";

/** 界面 30 秒放弃，前面的视频信息和列轨正常一两秒，留出余量。单个文件另有读取实现自己的上限。 */
export const DOWNLOAD_BUDGET_MS = 15_000;
export const MIN_ATTEMPT_MS = 1_000;

function baseLang(lang: string): string {
  const [base = ""] = lang.replace(/^ai[-_]/i, "").split("-");
  return base.toLowerCase();
}

/** 先试选中的那条，再试同语种的其他轨（简体空了换中文（中国））；没点名语言时最后试其余语言。 */
export function candidatesOf(tracks: readonly CaptionTrack[], chosen: CaptionTrack, lang: string): CaptionTrack[] {
  const rest = tracks.filter((track) => track.trackId !== chosen.trackId);
  const siblings = rest.filter((track) => baseLang(track.lang) === baseLang(chosen.lang));
  const others = lang ? [] : rest.filter((track) => !siblings.includes(track));
  return [chosen, ...siblings, ...others];
}

/** 换一条还可能读到的失败：只坏这一个文件。 */
function tryNext(result: Exclude<SiteResult<unknown>, { ok: true }>): boolean {
  if (result.code === "MALFORMED") return result.reach === "item";
  return result.code === "NETWORK" || result.code === "NO_CAPTIONS";
}

/** 站点的失败换成取字幕服务的结果形状：码、说明和等多久，影响范围只给批量处理用。 */
export function failureOf(result: Exclude<SiteResult<unknown>, { ok: true }>): Failure {
  const { code, detail, retryAfterSec } = result;
  return { ok: false, code, ...(detail === undefined ? {} : { detail }), ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
}

/** 一次读取里所有下载共用的预算。 */
export interface DownloadBudget {
  /** 要开始下载一条了：第一次调用时开始计时；剩不到 1 秒时交回 false，不再开始。 */
  begin(): boolean;
  /** 到点了：这次读取的环境已经中止。 */
  readonly expired: boolean;
  /** 读取结束，收掉计时器。 */
  dispose(): void;
}

export function downloadBudget(
  timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">,
  /** 中止这次读取的环境。 */
  abort: () => void,
  budgetMs = DOWNLOAD_BUDGET_MS,
): DownloadBudget {
  let deadline: number | null = null;
  let expired = false;
  let timer: unknown;
  return {
    begin() {
      if (deadline !== null) return deadline - timers.now() >= MIN_ATTEMPT_MS;
      deadline = timers.now() + budgetMs;
      timer = timers.setTimeout(() => {
        expired = true;
        abort();
      }, budgetMs);
      return true;
    },
    get expired() {
      return expired;
    },
    dispose() {
      if (timer !== undefined) timers.clearTimeout(timer);
    },
  };
}

export interface DownloadInput {
  readonly site: SiteService;
  readonly info: VideoInfo;
  readonly candidates: readonly CaptionTrack[];
  readonly ctx: SiteCtx;
  readonly budget: DownloadBudget;
}

/** 失败时 relist 说明重新列轨拿新地址还可能读到：只坏了文件（地址可能过期了），预算也没用完。 */
export type Downloaded =
  | { readonly ok: true; readonly track: CaptionTrack; readonly cues: readonly Cue[] }
  | { readonly ok: false; readonly failure: Failure; readonly relist: boolean };

export async function downloadFirst({ site, info, candidates, ctx, budget }: DownloadInput): Promise<Downloaded> {
  // 试过的文件都是空的才报空文件；别的失败以最后一次为准。
  let last: Failure | null = null;
  let relist = true;
  for (const track of candidates) {
    if (!budget.begin()) {
      relist = false;
      break;
    }
    const result = await site.readCaptions(info, track, ctx);
    if (result.ok && result.value.length > 0) return { ok: true, track, cues: result.value };
    if (budget.expired) return { ok: false, failure: fail("TIMEOUT", "download-budget"), relist: false };
    if (result.ok) continue;
    last = failureOf(result);
    relist = tryNext(result);
    if (!relist) break;
  }
  return { ok: false, failure: last ?? fail("EMPTY_CAPTION_FILE"), relist: relist && !budget.expired };
}
