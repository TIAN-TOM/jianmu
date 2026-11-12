// 路由表和端口表汇总：每个领域一行，并行加路由时各改各的文件。
import type { AnyPortSpec, Ports, Routes } from "../router.ts";
import { activationRoutes, type ActivationRouteDeps } from "./activation.ts";
import { aiRoutes, type AiRouteDeps } from "./ai.ts";
import { appearanceRoutes, type AppearanceRouteDeps } from "./appearance.ts";
import { batchPort, batchRoutes, type BatchRouteDeps } from "./batch.ts";
import { dataRoutes, type DataRouteDeps } from "./data.ts";
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
  DataRouteDeps &
  BatchRouteDeps;

export function createRoutes(deps: RouteDeps): Routes {
  return {
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
  };
}

export type PortDeps = TranslatePortDeps & BatchRouteDeps;

/** 端口表：翻译和粗筛。 */
export function createPorts(deps: PortDeps): Readonly<Record<string, AnyPortSpec>> {
  const ports: Ports = { ...translatePort(deps), ...batchPort(deps) };
  return ports as Readonly<Record<string, AnyPortSpec>>;
}
