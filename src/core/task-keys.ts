// 任务的两种键：互斥键管同一时间只跑一个，等价键管能不能直接接上在跑的那个。
import type { Basis } from "./notes/records.ts";
import type { FrozenGen, TaskKind } from "./tasks.ts";
import type { VideoKey } from "./video-ref.ts";

/** 不设互斥键的种类：同一视频可以同时问几个不同的问题，只按等价键合并连点。 */
const WITHOUT_MUTEX: ReadonlySet<TaskKind> = new Set<TaskKind>(["qa", "explain", "frame-explain"]);

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
  if (WITHOUT_MUTEX.has(kind)) return null;
  return kind === "translate" ? `${kind}:${video}:${lang ?? ""}` : `${kind}:${video}`;
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
