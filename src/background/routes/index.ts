// 路由表和端口表汇总：每个领域一行，并行加路由时各改各的文件。
import type { AnyPortSpec, Ports, Routes } from "../router.ts";
import { activationRoutes, type ActivationRouteDeps } from "./activation.ts";
import { aiRoutes, type AiRouteDeps } from "./ai.ts";
import { appearanceRoutes, type AppearanceRouteDeps } from "./appearance.ts";
import { batchPort, batchRoutes, type BatchRouteDeps } from "./batch.ts";
import { buildRoutes } from "./build.ts";
import { dataPorts, dataRoutes, type DataRouteDeps } from "./data.ts";
import { frameRoutes, type FrameRouteDeps } from "./frame.ts";
import { youtubeRoutes, type YoutubeRouteDeps } from "./youtube.ts";
import { grantRoutes, type GrantRouteDeps } from "./grants.ts";
import { importRoutes, type ImportRouteDeps } from "./imports.ts";
import { noteRoutes, type NoteRouteDeps } from "./notes.ts";
import { overviewRoutes, type OverviewRouteDeps } from "./overview.ts";
import { pageRoutes, type PageRouteDeps } from "./pages.ts";
import { qaRoutes, type QaRouteDeps } from "./qa.ts";
import { sessionRoutes, type SessionRouteDeps } from "./session.ts";
import { taskRoutes, type TaskRouteDeps } from "./tasks.ts";
import { transcriptRoutes, type TranscriptRouteDeps } from "./transcript.ts";
import { translatePort, type TranslatePortDeps } from "./translate.ts";
import { verdictRoutes, type VerdictRouteDeps } from "./verdict.ts";

// 解释当前画面的服务由 app.ts 在开关分支里装配，从这里取。
export { createFrameParts } from "../services/frame-explain.ts";

export type RouteDeps = ActivationRouteDeps &
  AppearanceRouteDeps &
  PageRouteDeps &
  AiRouteDeps &
  TaskRouteDeps &
  SessionRouteDeps &
  GrantRouteDeps &
  TranscriptRouteDeps &
  ImportRouteDeps &
  OverviewRouteDeps &
  VerdictRouteDeps &
  QaRouteDeps &
  NoteRouteDeps &
  Pick<DataRouteDeps, "data"> &
  BatchRouteDeps &
  FrameRouteDeps &
  YoutubeRouteDeps;

/** 画面那几条路由只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进表，YouTube 代开文字稿只在 FEATURE_YOUTUBE_OPEN_PANEL 打开时进表。 */
export function createRoutes(deps: RouteDeps): Routes {
  return {
    ...buildRoutes(),
    ...activationRoutes(deps),
    ...appearanceRoutes(deps),
    ...pageRoutes(deps),
    ...aiRoutes(deps),
    ...taskRoutes(deps),
    ...sessionRoutes(deps),
    ...grantRoutes(deps),
    ...transcriptRoutes(deps),
    ...importRoutes(deps),
    ...overviewRoutes(deps),
    ...verdictRoutes(deps),
    ...qaRoutes(deps),
    ...noteRoutes(deps),
    ...dataRoutes(deps),
    ...batchRoutes(deps),
    ...(FEATURE_FRAME_EXPLAIN ? frameRoutes(deps) : {}),
    ...(FEATURE_YOUTUBE_OPEN_PANEL ? youtubeRoutes(deps) : {}),
  };
}

export type PortDeps = TranslatePortDeps & BatchRouteDeps & DataRouteDeps;

/** 端口表：翻译、粗筛，导出和导入备份。 */
export function createPorts(deps: PortDeps): Readonly<Record<string, AnyPortSpec>> {
  const ports: Ports = { ...translatePort(deps), ...batchPort(deps), ...dataPorts(deps) };
  return ports as Readonly<Record<string, AnyPortSpec>>;
}
