// 路由表和端口表汇总：每个领域一行，并行加路由时各改各的文件。
import type { AnyPortSpec, Routes } from "../router.ts";
import { activationRoutes, type ActivationRouteDeps } from "./activation.ts";
import { aiRoutes, type AiRouteDeps } from "./ai.ts";
import { appearanceRoutes, type AppearanceRouteDeps } from "./appearance.ts";
import { grantRoutes, type GrantRouteDeps } from "./grants.ts";
import { pageRoutes, type PageRouteDeps } from "./pages.ts";
import { sessionRoutes, type SessionRouteDeps } from "./session.ts";
import { taskRoutes, type TaskRouteDeps } from "./tasks.ts";

export type RouteDeps = ActivationRouteDeps &
  AppearanceRouteDeps &
  PageRouteDeps &
  AiRouteDeps &
  TaskRouteDeps &
  SessionRouteDeps &
  GrantRouteDeps;

export function createRoutes(deps: RouteDeps): Routes {
  return {
    ...activationRoutes(deps),
    ...appearanceRoutes(deps),
    ...pageRoutes(deps),
    ...aiRoutes(deps),
    ...taskRoutes(deps),
    ...sessionRoutes(deps),
    ...grantRoutes(deps),
  };
}

/** 端口表：翻译和批量处理的端口随各自的服务接上，在那之前谁连都断开。 */
export function createPorts(): Readonly<Record<string, AnyPortSpec>> {
  return {};
}
