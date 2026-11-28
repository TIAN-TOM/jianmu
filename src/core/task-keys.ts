// 任务的两种键：互斥键管同一时间只跑一个，等价键管能不能直接接上在跑的那个。
import type { Basis } from "./notes/records.ts";
import type { FrozenGen, TaskKind } from "./tasks.ts";
import type { VideoKey } from "./video-ref.ts";

/** 互斥键怎么取：不设（同一视频可以同时问几个不同的问题，只按等价键合并连点）、按视频、按视频和目标语言。 */
export type MutexScope = "none" | "video" | "video-and-target";

export interface TaskKeyRule {
  readonly mutexScope: MutexScope;
  /** 取消后、已经发出的那次收尾之前仍占着键。来源是自动生成的任务也占，那一条按来源判断，不在这里。 */
  readonly holdsKeyAfterCancel: boolean;
}

/** 每种任务的键怎么取、取消后占不占键。加种类时类型要求这里补一行。 */
export const TASK_KEY_RULES: Readonly<Record<TaskKind, TaskKeyRule>> = {
  overview: { mutexScope: "video", holdsKeyAfterCancel: false },
  verdict: { mutexScope: "video", holdsKeyAfterCancel: false },
  translate: { mutexScope: "video-and-target", holdsKeyAfterCancel: false },
  qa: { mutexScope: "none", holdsKeyAfterCancel: false },
  explain: { mutexScope: "none", holdsKeyAfterCancel: false },
  "frame-explain": { mutexScope: "none", holdsKeyAfterCancel: false },
  "triage-verdict": { mutexScope: "video", holdsKeyAfterCancel: true },
  batch: { mutexScope: "video", holdsKeyAfterCancel: true },
};

/** 任务管理器里的种类是字符串：认不出的种类按不占键算。 */
export const kindHoldsKeyAfterCancel = (kind: string): boolean =>
  Object.hasOwn(TASK_KEY_RULES, kind) && TASK_KEY_RULES[kind as TaskKind].holdsKeyAfterCancel;

export interface MutexInput {
  readonly kind: TaskKind;
  readonly video: VideoKey;
  /** 翻译的目标语言。 */
  readonly lang?: string | undefined;
}

export interface EquivalenceInput extends MutexInput {
  /** 依据还没定时不传：先按视频、功能输入和生成配置判断。 */
  readonly basis?: Basis | undefined;
  /** 功能输入：问题、选区、补块的区间这类。 */
  readonly input?: unknown;
  readonly gen: FrozenGen;
  /** 任务里另几项功能取定的配置，没有时不进键。 */
  readonly stages?: readonly FrozenGen[] | undefined;
}

/** `<种类>:<视频键>`，翻译再加目标语言；问答、划词解释、画面解释没有互斥键。 */
export function mutexKey({ kind, video, lang }: MutexInput): string | null {
  const scope = TASK_KEY_RULES[kind].mutexScope;
  if (scope === "none") return null;
  return scope === "video-and-target" ? `${kind}:${video}:${lang ?? ""}` : `${kind}:${video}`;
}

// 对象的键排好序、去掉值为 undefined 的键，同样的内容换个写法得出同一串。
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 种类、视频、依据、功能输入、生成配置（含另几项功能的）规范化后取哈希。 */
export function equivalenceKey({ kind, video, lang, basis, input, gen, stages }: EquivalenceInput): Promise<string> {
  const parts = { kind, video, lang: lang ?? null, basis: basis ?? null, input: input ?? null, gen, ...(stages?.length ? { stages } : {}) };
  return sha256Hex(JSON.stringify(canonical(parts)));
}
