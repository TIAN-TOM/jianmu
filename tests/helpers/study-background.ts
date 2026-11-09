// 问答、划词解释和笔记走真实后台分发的测试架子：真实的路由、任务、仓储、设置读取和传输层，
// 视频网站读取换成站点替身，模型服务换成网络这一层的替身。提示词用仓库里的原文。
import { readFileSync } from "node:fs";
import { createApp } from "../../src/background/app.ts";
import type { MessageSender } from "../../src/background/senders.ts";
import type { Result } from "../../src/core/errors.ts";
import type { Cue, SiteRules } from "../../src/sites/types.ts";
import { PROTOCOLS } from "../../src/core/ai/provider/index.ts";
import { createFakeChrome, senders } from "./chrome.ts";
import { keyedStorage, modelService, type ServiceHandler } from "./fake-model-service.ts";
import { fakeSiteService } from "./fake-site-service.ts";

export const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model" };
export const GATEWAY_ORIGIN = "https://gateway.example.com/";

const readPrompt = (file: string): string => readFileSync(new URL(`../../prompts/${file}`, import.meta.url), "utf8").replaceAll("\r", "");
const PROMPT_FILES = Object.fromEntries(["qa.md", "explain.md", "note-cleanup.md"].map((file) => [file, readPrompt(file)]));

export interface StudyBackgroundOptions {
  readonly handler?: ServiceHandler;
  /** 站点替身给的字幕条；不给时用替身自己的两句。 */
  readonly cues?: readonly Cue[];
  /** 换成真实的地址规则，按真实的播放页地址认视频。 */
  readonly siteRules?: readonly SiteRules[];
  /** 没填 AI 配置：只确认了启用。 */
  readonly withoutAi?: boolean;
}

export function studyBackground(options: StudyBackgroundOptions = {}) {
  const ai = modelService(options.handler);
  const site = fakeSiteService(options.cues ? { captions: () => ({ ok: true, value: [...(options.cues ?? [])] }) } : {});
  const storage = keyedStorage(options.withoutAi ? { presetId: "custom" } : GATEWAY, GATEWAY_ORIGIN);
  const fake = createFakeChrome({ ...storage, grantedOrigins: [GATEWAY_ORIGIN], fetch: ai.fetch, prompts: PROMPT_FILES, site: site.service });
  const logged: unknown[][] = [];
  const deps = fake.deps({ warn: (...args: unknown[]) => void logged.push(args), error: (...args: unknown[]) => void logged.push(args) });
  const app = createApp(options.siteRules ? { ...deps, siteRules: options.siteRules } : deps);
  const send = <T = unknown>(type: string, req: unknown, sender: MessageSender = senders.panel()): Promise<Result<T>> =>
    Promise.resolve(app.dispatch({ type, req }, sender)) as Promise<Result<T>>;
  return { ai, site, fake, app, logged, send };
}
