// 画面分析的模型能不能看图：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 先看探测记下的结果，没有就看本机的模型能力（型号表认得出的算能看）；都说不准时发一张红色小图探一次，
// 回答里要说得出是红色才算能看：有的中转会悄悄丢掉图片照常回话。
// 探测结果按「API 地址加模型」存在本机。真实请求被以看不了图拒掉时，由调用方再探一次复核，不直接记。
// 模块顶层只放字面量和函数，理由见 content/frame.ts 开头。
import { fail, ok, type Result } from "../core/errors.ts";
import type { ClearGuard } from "../core/clear-guard.ts";
import type { FrozenGen } from "../core/tasks.ts";
import type { StorageArea } from "../platform/storage.ts";
import { IMAGE_PROBE_STORAGE_KEY } from "../shared/names.ts";
import { aiFailure, type AiWiring } from "./ai.ts";

/** 一张 64×64 的红色 JPEG，探测用，693 字节。比 8×8 大，是因为有的服务要求宽高都超过 10 像素、总像素不少于 196。 */
export const PROBE_IMAGE =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiaKKK+PP6QCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z";

const PROBE_QUESTION = "这张小图是什么颜色？只回一个词。";
// 回答里说得出是红色才算看到了图。
const SAW_RED = /红|red|crimson|scarlet/i;
// 关不掉思考的模型，思考也算在预算里；上限本身不收费。
const PROBE_MAX_TOKENS = 1024;
/** 探测结果留 30 天：模型的看图能力很少变，换了模型就是另一条。写成字面量，算式会让模块留在发行包里。 */
export const PROBE_TTL_MS = 2_592_000_000;
const MAX_PROBES = 16;

// 服务收下了请求、只是没写出正常的回答：图是收下了的。
const ANSWERED: ReadonlySet<unknown> = new Set(["EMPTY_AI_RESPONSE", "AI_RESPONSE_TRUNCATED", "AI_REFUSED"]);

// 服务拒收图片时常见的说法。只在请求里带了图、服务回 4xx 时才拿来比。
const IMAGE_REJECTION = /image|vision|multi-?modal|input_image|image_url|图片|图像|视觉|多模态/i;

interface ProbeEntry {
  readonly imageInput: boolean;
  readonly at: number;
}

/** 带图的请求被服务以看不了图拒掉：4xx，说明里提到图片。 */
export function isImageRejection(error: unknown): boolean {
  const failure = error as { readonly status?: unknown; readonly message?: unknown } | null;
  const status = Number(failure?.status);
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 404 && status !== 429 && IMAGE_REJECTION.test(String(failure?.message ?? ""));
}

const keyOf = (gen: Pick<FrozenGen, "baseUrl" | "model">): string => `${gen.baseUrl}|${gen.model}`;

export interface ImageSupportDeps {
  readonly storage: Pick<StorageArea, "get" | "set">;
  readonly clearGuard: ClearGuard;
  readonly ai: Pick<AiWiring, "capabilities" | "forTask">;
  readonly now: () => number;
}

export interface ImageSupport {
  /** 已知的看图能力：探测记下的优先，再看本机的模型能力；说不准时是 unknown，不发请求。 */
  readonly known: (gen: FrozenGen) => Promise<boolean | "unknown">;
  /** 发一张 8×8 的图探一次并记下。连不上、密钥不对这类和看图无关的失败照常报错，不记。 */
  readonly probe: (gen: FrozenGen) => Promise<Result<{ readonly imageInput: boolean }>>;
  /** 说不准就探一次。 */
  readonly ensure: (gen: FrozenGen) => Promise<Result<{ readonly imageInput: boolean }>>;
}

export function createImageSupport({ storage, clearGuard, ai, now }: ImageSupportDeps): ImageSupport {
  async function readAll(): Promise<Record<string, ProbeEntry>> {
    try {
      const stored = (await storage.get(IMAGE_PROBE_STORAGE_KEY))[IMAGE_PROBE_STORAGE_KEY];
      return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, ProbeEntry>) } : {};
    } catch {
      return {};
    }
  }

  async function remembered(gen: FrozenGen): Promise<boolean | null> {
    const entry = (await readAll())[keyOf(gen)];
    const age = now() - Number(entry?.at);
    return typeof entry?.imageInput === "boolean" && age >= 0 && age < PROBE_TTL_MS ? entry.imageInput : null;
  }

  // 探测要等网络，这期间清除了缓存就不写回去。
  async function remember(gen: FrozenGen, imageInput: boolean, since: ReturnType<ClearGuard["epoch"]>): Promise<void> {
    try {
      await clearGuard.track(async () => {
        if (clearGuard.clearedSince(since, "cache")) return;
        const all = await readAll();
        all[keyOf(gen)] = { imageInput, at: now() };
        const kept = Object.entries(all)
          .sort((a, b) => Number(b[1]?.at) - Number(a[1]?.at))
          .slice(0, MAX_PROBES);
        await storage.set({ [IMAGE_PROBE_STORAGE_KEY]: Object.fromEntries(kept) });
      });
    } catch {
      // 存不进去下次再探，不影响这一次。
    }
  }

  async function known(gen: FrozenGen): Promise<boolean | "unknown"> {
    const probed = await remembered(gen);
    if (probed !== null) return probed;
    return (await ai.capabilities(gen)).imageInput;
  }

  async function probe(gen: FrozenGen): Promise<Result<{ readonly imageInput: boolean }>> {
    const since = clearGuard.epoch();
    let answer: string;
    try {
      ({ text: answer } = await ai.forTask(gen).requestAiCompletion({
        messages: [{ role: "user", content: [{ type: "image", dataUrl: PROBE_IMAGE }, { type: "text", text: PROBE_QUESTION }] }],
        maxTokens: PROBE_MAX_TOKENS,
        selfRetry: false,
      }));
    } catch (error) {
      const answered = ANSWERED.has((error as { readonly code?: unknown } | null)?.code);
      if (answered) {
        await remember(gen, true, since);
        return ok({ imageInput: true });
      }
      if (!isImageRejection(error)) return aiFailure(error);
      await remember(gen, false, since);
      return ok({ imageInput: false });
    }
    // 回话了但说不出是红色：多半是图被丢掉了，按不能看记。
    const saw = SAW_RED.test(answer);
    await remember(gen, saw, since);
    return ok({ imageInput: saw });
  }

  return {
    known,
    probe,
    async ensure(gen) {
      const value = await known(gen);
      return value === "unknown" ? probe(gen) : ok({ imageInput: value });
    },
  };
}

/** 能看图时放行，不能看时回专门的码。 */
export function requireImage(result: Result<{ readonly imageInput: boolean }>): Result<true> {
  if (!result.ok) return result;
  return result.value.imageInput ? ok(true) : fail("AI_IMAGE_UNSUPPORTED");
}
