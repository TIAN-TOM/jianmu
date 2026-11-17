// 推理强度的映射，集中在这一张表：协议 × 域名 × 型号 × 档位 → 请求体补丁、实际生效的档位、输出余量和超时。
// 选关时请求和以前一样；Google 模型服务的兼容端点例外：关得掉的显式关，关不掉的按最低档发并标出。
// 做不到的档位退到最接近的一档并标出，不悄悄退回不发。各档的数值都是初值。
import type { Effort } from "../../notes/records.ts";
import { parseClaudeModel } from "./anthropic.ts";
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import { isOpenAiReasoningModel, openAiModelTraits } from "./openai.ts";
import type { ClaudeCapabilities, EffortNote, EffortPlan, ModelCapabilities, RelaxState } from "./types.ts";

/** 设置页能选的档位，从低到高。 */
export const EFFORTS: readonly Effort[] = Object.freeze(["off", "low", "medium", "high"]);

const LEVELS: readonly Effort[] = Object.freeze(["low", "medium", "high"]);

/** 各档给思考留的输出余量和单次请求的硬超时，关就是原来的预算和 120 秒。 */
export const EFFORT_BUDGETS: Readonly<Record<Effort, { readonly outputHeadroom: number; readonly timeoutSec: number }>> =
  Object.freeze({
    off: Object.freeze({ outputHeadroom: 0, timeoutSec: 120 }),
    low: Object.freeze({ outputHeadroom: 2048, timeoutSec: 120 }),
    medium: Object.freeze({ outputHeadroom: 6144, timeoutSec: 180 }),
    high: Object.freeze({ outputHeadroom: 16384, timeoutSec: 300 }),
  });

export const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);

/** 地址的主机名，小写；地址不合法时是空串。 */
export function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 精确到域名本身或其子域，形近的域名不算。
const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

const DEEPSEEK = "deepseek.com";
const GOOGLE = "generativelanguage.googleapis.com";
const OPENAI = "api.openai.com";

/** 这个服务和型号做得到哪些档位、关不关得掉思考。 */
export interface EffortSupport {
  readonly canDisableThinking: boolean | "unknown";
  readonly efforts: readonly Effort[];
}

export interface EffortTarget {
  readonly protocol: Protocol;
  readonly host: string;
  readonly model: string;
  /** 从模型列表读到的 Claude 能力，没有时按型号名判断。 */
  readonly claude?: ClaudeCapabilities | null | undefined;
  /** 这组设置记住的放宽项。 */
  readonly relax?: RelaxState | undefined;
}

const UNKNOWN: EffortSupport = Object.freeze({ canDisableThinking: "unknown", efforts: Object.freeze([]) });

function support(canDisableThinking: boolean | "unknown", levels: readonly Effort[]): EffortSupport {
  return { canDisableThinking, efforts: [...(canDisableThinking === true ? (["off"] as const) : []), ...levels] };
}

// 能调档位的只有自适应思考的型号；只有手动思考预算的老型号只能关。
function claudeSupport(model: string, claude: ClaudeCapabilities | null | undefined, relax: RelaxState | undefined): EffortSupport {
  let canDisable: boolean;
  let levels: readonly Effort[];
  if (claude) {
    const types = claude.thinking ?? {};
    canDisable = Boolean(types.disabled || types.betweenTools);
    levels = types.adaptive ? LEVELS.filter((level) => claude.efforts?.includes(level)) : [];
  } else {
    const info = parseClaudeModel(model);
    if (!info) return UNKNOWN;
    const { family, major, minor } = info;
    const atLeast = (a: number, b: number): boolean => major > a || (major === a && minor >= b);
    const named = family === "fable" || family === "mythos";
    canDisable = !(named || (family === "opus" && atLeast(5, 5)));
    const adaptive = named || ((family === "opus" || family === "sonnet") && atLeast(4, 6)) || (family === "haiku" && atLeast(5, 5));
    levels = adaptive ? LEVELS : [];
  }
  // 关思考被拒过、又没有替代写法：这组设置实际关不掉。
  if (relax?.thinking === true) canDisable = false;
  return support(canDisable, levels);
}

function responsesSupport(model: string, relax: RelaxState | undefined): EffortSupport {
  // 档位参数被拒过，之后都不发，由型号自己决定。
  if (relax?.effort) return UNKNOWN;
  const traits = openAiModelTraits(model);
  if (traits.known) return support(traits.effort === "none", LEVELS);
  return traits.reasoning ? support("unknown", LEVELS) : support(true, []);
}

// Google 的兼容端点：2.5 的 Flash 系列关得掉；2.5 Pro 和 3 以后的关不掉；更早的型号不思考。
function geminiSupport(model: string): EffortSupport {
  const match = model.toLowerCase().replace(/^models\//, "").match(/^gemini-(\d+)(?:\.(\d+))?-([a-z]+)/);
  if (!match) return UNKNOWN;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major >= 3 || (major === 2 && minor >= 5 && match[3] !== "flash")) return support(false, LEVELS);
  if (major === 2 && minor >= 5) return support(true, LEVELS);
  return support(true, []);
}

function chatSupport(host: string, model: string): EffortSupport {
  // DeepSeek 只有低、高两档（另有更高的一档，这里用不上）。
  if (onDomain(host, DEEPSEEK)) return support(true, ["low", "high"]);
  if (host === GOOGLE) return geminiSupport(model);
  if (host === OPENAI) return isOpenAiReasoningModel(model) ? support("unknown", LEVELS) : support(true, []);
  // 别的兼容服务各有各的写法，认不出就不发，免得严格的网关因为不认识的参数拒掉请求。
  return UNKNOWN;
}

export function effortSupport({ protocol, host, model, claude, relax }: EffortTarget): EffortSupport {
  if (protocol === PROTOCOLS.ANTHROPIC) return claudeSupport(model, claude, relax);
  if (protocol === PROTOCOLS.RESPONSES) return responsesSupport(model, relax);
  return chatSupport(host, model);
}

type Patch = Readonly<Record<string, unknown>>;

interface Patches {
  /** 选关、关得掉时。 */
  readonly off: Patch;
  /** 选关、关不掉时：按最低档发。空的就是沿用原来的做法，原来已经按最低档发了。 */
  readonly floor: Patch;
  readonly level: (effort: Effort) => Patch;
}

const NONE: Patch = Object.freeze({});

function patchesFor(protocol: Protocol, host: string, model: string): Patches {
  if (protocol === PROTOCOLS.ANTHROPIC) {
    // 有的型号默认不思考，显式写自适应才会按档位思考。
    return { off: NONE, floor: NONE, level: (effort) => ({ thinking: { type: "adaptive" }, output_config: { effort } }) };
  }
  if (protocol === PROTOCOLS.RESPONSES) {
    return { off: NONE, floor: NONE, level: (effort) => ({ reasoning: { effort } }) };
  }
  if (onDomain(host, DEEPSEEK)) {
    return { off: NONE, floor: NONE, level: (effort) => ({ thinking: { type: "enabled" }, reasoning_effort: effort }) };
  }
  if (host === GOOGLE) {
    // 会思考、又关得掉的型号要显式关；不思考的老型号什么都不发。
    const thinks = geminiSupport(model).efforts.some((effort) => effort !== "off");
    return { off: thinks ? { reasoning_effort: "none" } : NONE, floor: { reasoning_effort: "low" }, level: (effort) => ({ reasoning_effort: effort }) };
  }
  return { off: NONE, floor: NONE, level: (effort) => ({ reasoning_effort: effort }) };
}

export interface EffortPlanInput {
  readonly protocol: Protocol;
  readonly host: string;
  readonly model: string;
  readonly requested: Effort;
  readonly caps: Pick<ModelCapabilities, "canDisableThinking" | "efforts">;
}

const rank = (effort: Effort): number => EFFORTS.indexOf(effort);

/**
 * 按用户选的档位和这个服务、型号的能力，算出实际生效的档位和请求体补丁。
 * 「关」不会变成更高的默认档：关不掉的按最低档发，扩展设不了的照旧不发。
 * 输出余量和超时按选的和实际的两者中低的那档算，所以选关时预算和超时都和以前一样。
 */
export function planEffort({ protocol, host, model, requested, caps }: EffortPlanInput): EffortPlan {
  const supported = EFFORTS.filter((effort) => caps.efforts.includes(effort));
  const patches = patchesFor(protocol, host, model);
  let effective: Effort = requested;
  let note: EffortNote | undefined;
  let patch: Patch;
  if (!supported.length || (requested === "off" && caps.canDisableThinking === "unknown")) {
    effective = "off";
    note = "unknown";
    patch = NONE;
  } else if (requested === "off") {
    if (supported.includes("off")) {
      patch = patches.off;
    } else {
      effective = supported[0] as Effort;
      note = "cannot-disable";
      patch = patches.floor;
    }
  } else {
    if (!supported.includes(requested)) {
      const lower = supported.filter((effort) => rank(effort) < rank(requested)).at(-1);
      effective = lower ?? (supported[0] as Effort);
      note = "fallback";
    }
    patch = effective === "off" ? patches.off : patches.level(effective);
  }
  const budget = EFFORT_BUDGETS[rank(effective) < rank(requested) ? effective : requested];
  return {
    requested,
    effective,
    ...(note ? { note } : {}),
    patch,
    outputHeadroom: budget.outputHeadroom,
    timeoutSec: budget.timeoutSec,
  };
}
