// 拼装概览服务：分块大小按设置；发往模型的请求几个视频、两种生成合起来不超过并发上限。从 app.ts 拆出来，免得它超长。
import { analysisChunkOptions } from "../shared/settings-schema.ts";
import type { AppDeps, OverviewParts } from "./app.ts";
import { createOverviewService, type OverviewService } from "./services/overview/index.ts";

export function assembleOverview(deps: Pick<AppDeps, "log" | "timers" | "sites">, parts: OverviewParts): OverviewService {
  return createOverviewService({
    tasks: parts.tasks,
    transcript: parts.transcript,
    overviews: parts.overviews,
    guard: parts.clearGuard,
    prompt: parts.ai.prompt,
    chunkOptions: async () => analysisChunkOptions(await parts.settings.loadPublic()),
    gate: parts.gate,
    broadcast: (message) => void parts.messenger.toPages(message),
    log: deps.log,
    now: deps.timers.now,
    // 读评论区（PRD F23）用；构建开关关着时概览服务不用它。
    sites: deps.sites,
  });
}
