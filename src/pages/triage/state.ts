// 粗筛页的状态和动作。三步都经长连接 batch 交给后台做：读列表、逐个取官方总结、写一句话结论；后台做完一个推一个。
// 页面开着连接就开着，关掉页面连接断开，后台撤掉还在排队的。开始前就地确认，写清数量、跳过规则和费用。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { describe, errorCopy, type ErrorCode, type Failure } from "../../core/errors.ts";
import { hasOfficialContent, isOfficialDone, OFFICIAL_INTERVAL_MS, officialTodo, verdictTodo } from "../../core/triage/batch.ts";
import { exportFileName, formatDateTime, toMarkdown } from "../../core/triage/export.ts";
import { hasVerdict, type GroupKey } from "../../core/triage/groups.ts";
import type { OfficialRecord, TriageItem } from "../../core/triage/state.ts";
import type { PortEvent } from "../../shared/messages.ts";
import type { BatchFailure, TriageOut, TriageSnapshot, TriageStep, TriageStop } from "../../shared/messages/batch.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import type { PageApi, PagePort } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { triageTextOf } from "./text.ts";

export type Tone = "ok" | "warn" | "error";

export interface Status {
  readonly text: string;
  readonly tone?: Tone;
}

/** 要用户点确认的那一步：说明几行，确认后开始。 */
export interface Pending {
  readonly step: "official" | "verdict";
  readonly lines: readonly string[];
}

export type Filter = GroupKey | "all";

export interface TriageDeps {
  readonly api: Pick<PageApi, "send" | "connect">;
  /** 视频页的地址，按站点规则拼。 */
  readonly videoUrl: (item: TriageItem) => string;
  /** 视频地址的前缀，导出 Markdown 用：按列表里的一个视频算。 */
  readonly videoBase: (videoKey: string) => string;
  readonly download: (filename: string, text: string) => void;
  readonly now?: () => number;
  /** 界面语言：状态行和确认的几行按写出来那一刻的语言写，导出的清单和文件名也按它。不给时是中文。 */
  readonly lang?: () => UiLang;
}

export interface TriageState {
  /** 还没问到是 null。 */
  readonly snapshot: ReadonlySignal<TriageSnapshot | null>;
  readonly loadFailure: ReadonlySignal<Failure | null>;
  /** 后台正在跑的一步：这一页发起的，或者别的页面发起、这一页接上的。 */
  readonly running: ReadonlySignal<TriageStep | null>;
  readonly stopping: ReadonlySignal<boolean>;
  readonly pending: ReadonlySignal<Pending | null>;
  readonly listStatus: ReadonlySignal<Status | null>;
  readonly officialStatus: ReadonlySignal<Status | null>;
  readonly verdictStatus: ReadonlySignal<Status | null>;
  /** 这一次打开页面里写结论失败的原因，连同模型服务自己说的话，只显示，不存。 */
  readonly errors: ReadonlySignal<Readonly<Record<string, ItemError>>>;
  readonly filter: ReadonlySignal<Filter>;
  readonly items: ReadonlySignal<readonly TriageItem[]>;
  readonly videoUrl: (item: TriageItem) => string;
  load(): Promise<void>;
  readList(): void;
  askOfficial(): void;
  askVerdicts(): Promise<void>;
  confirm(): void;
  cancel(): void;
  stop(): void;
  setFilter(filter: Filter): void;
  exportMarkdown(): void;
  /** 设置页清除了本机数据：列表和官方总结都没了。 */
  cleared(): void;
  dispose(): void;
}

const EMPTY: TriageSnapshot = { list: null, official: {}, verdicts: {}, running: null };

/** 一个视频写结论失败的说明；said 是模型服务自己说的话。 */
export interface ItemError {
  readonly text: string;
  readonly said?: string;
}

/** 官方总结没取成的原因：被限流单说一句，别的照错误码的说明。 */
export function officialRecordText(record: OfficialRecord | undefined, item: TriageItem, lang: UiLang = "zh"): string {
  const t = triageTextOf(lang).record;
  if (item.available === false) return t.unavailable;
  if (!record) return t.notFetched;
  if (record.status === "ok" && !hasOfficialContent(record)) return t.none;
  switch (record.status) {
    case "none":
      return t.none;
    case "queued":
      return t.queued;
    case "unsupported":
      return t.unsupported;
    case "need-login":
      return t.needLogin;
    default:
      if (record.reason === "RATE_LIMITED") return t.rateLimited;
      return t.failed(errorCopy((record.reason ?? "BACKGROUND_FAILED") as ErrorCode, undefined, lang).cause);
  }
}

/** 第一步取完以后的分类计数。 */
export function officialCounts(items: readonly TriageItem[], official: Readonly<Record<string, OfficialRecord | undefined>>, lang: UiLang = "zh"): string {
  const t = triageTextOf(lang).counts;
  let ok = 0;
  let none = 0;
  let later = 0;
  let pending = 0;
  for (const item of items) {
    if (item.available === false) continue;
    const record = official[item.videoKey];
    if (!record) pending += 1;
    else if (hasOfficialContent(record)) ok += 1;
    else if (isOfficialDone(record)) none += 1;
    else later += 1;
  }
  const parts = [t.ok(ok)];
  if (none) parts.push(t.none(none));
  if (later) parts.push(t.later(later));
  if (pending) parts.push(t.pending(pending));
  return t.join(parts);
}

export function listSummary(snapshot: TriageSnapshot, lang: UiLang = "zh"): string {
  const t = triageTextOf(lang).summary;
  const list = snapshot.list;
  if (!list) return "";
  const parts = [t.total(list.items.length, formatDateTime(list.fetchedAt))];
  if (list.count > list.items.length) parts.push(t.short(list.count, list.items.length));
  const unavailable = list.items.filter((item) => item.available === false).length;
  if (unavailable) parts.push(t.unavailable(unavailable));
  return parts.join("");
}

function stopText(stop: TriageStop | undefined, done: number, total: number, again: string, lang: UiLang): string | null {
  const t = triageTextOf(lang).stopped;
  const tally = t.tally(done, total);
  switch (stop) {
    case "rate-limited":
      return t.rateLimited(tally, again);
    case "need-login":
      return t.needLogin(tally, again);
    case "source":
      return t.source(tally, again);
    case "stopped":
      return t.stopped(tally, again);
    default:
      return null;
  }
}


export function createTriageState(deps: TriageDeps): TriageState {
  const { api } = deps;
  const now = deps.now ?? Date.now;
  const lang = (): UiLang => deps.lang?.() ?? "zh";
  const t = () => triageTextOf(lang());
  const failureText = (failure: BatchFailure): string => describe(failure.code, undefined, lang());
  const snapshot = signal<TriageSnapshot | null>(null);
  const loadFailure = signal<Failure | null>(null);
  const running = signal<TriageStep | null>(null);
  const stopping = signal(false);
  const pending = signal<Pending | null>(null);
  const listStatus = signal<Status | null>(null);
  const officialStatus = signal<Status | null>(null);
  const verdictStatus = signal<Status | null>(null);
  const errors = signal<Readonly<Record<string, ItemError>>>({});
  const filter = signal<Filter>("all");
  const items = computed(() => snapshot.value?.list?.items ?? []);
  let port: PagePort<"batch"> | null = null;
  /** 这一轮写结论里写好、失败的个数。 */
  let tally = { written: 0, failed: 0 };
  /** 正在跑的那一步一共几个。 */
  let runningTotal = 0;

  const current = (): TriageSnapshot => snapshot.peek() ?? EMPTY;
  const statusOf = (step: TriageStep) => (step === "list" ? listStatus : step === "official" ? officialStatus : verdictStatus);

  function apply(next: TriageSnapshot): void {
    snapshot.value = next;
    running.value = next.running;
  }

  async function load(): Promise<void> {
    const reply = await api.send("triage.state", {});
    if (!reply.ok) {
      loadFailure.value = reply;
      return;
    }
    loadFailure.value = null;
    apply(reply.value);
    if (reply.value.list) {
      listStatus.value = { text: `${listSummary(reply.value, lang())}${t().readAgain}` };
      officialStatus.value = { text: officialCounts(reply.value.list.items, reply.value.official, lang()) };
    }
    // 别的页面正在跑的一步：发一次同一步的开始，后台把这一页接上，之后的进度、停止和关页面都算这一页一份。
    if (reply.value.running) ensurePort().post({ type: "triage.start", step: reply.value.running });
  }

  function onItem(event: Extract<TriageOut, { type: "triage.item" }>): void {
    const shown = current();
    const official = event.official ? { ...shown.official, [event.video]: event.official } : shown.official;
    const verdicts = event.verdict ? { ...shown.verdicts, [event.video]: event.verdict } : shown.verdicts;
    const list =
      event.unavailable && shown.list
        ? { ...shown.list, items: shown.list.items.map((item) => (item.videoKey === event.video ? { ...item, available: false } : item)) }
        : shown.list;
    snapshot.value = { ...shown, list, official, verdicts };
    if (event.step === "verdict") {
      if (event.verdict) tally = { ...tally, written: tally.written + 1 };
      else if (event.failure && event.failure.code !== "TASK_CANCELED" && event.failure.code !== "TASK_ALREADY_RUNNING") {
        tally = { ...tally, failed: tally.failed + 1 };
        const text = t().verdictFailed(errorCopy(event.failure.code, undefined, lang()).cause);
        errors.value = { ...errors.peek(), [event.video]: event.failure.said ? { text, said: event.failure.said } : { text } };
      }
    }
    if (!stopping.peek()) statusOf(event.step).value = { text: t().progress(event.step === "official" ? t().fetching : t().writing, event.done, runningTotal) };
  }

  function onDone(event: Extract<TriageOut, { type: "triage.done" }>): void {
    running.value = null;
    stopping.value = false;
    const status = statusOf(event.step);
    if (event.step === "list") {
      if (event.failure) {
        status.value = { text: failureText(event.failure), tone: "error" };
        return;
      }
      if (event.state) apply({ ...event.state, running: null });
      errors.value = {};
      filter.value = "all";
      const dropped = event.dropped ? t().dropped(event.dropped) : "";
      status.value = { text: `${listSummary(current(), lang())}${dropped}`.trimEnd() };
      officialStatus.value = { text: officialCounts(items.peek(), current().official, lang()) };
      return;
    }
    if (event.failure && event.failure.code === "TRIAGE_LIST_CLEARED") {
      status.value = { text: failureText(event.failure), tone: "error" };
      void load();
      return;
    }
    if (event.step === "official") {
      const counts = officialCounts(items.peek(), current().official, lang());
      const stopped = stopText(event.stop, event.done, event.total, t().stopped.officialAgain, lang());
      status.value = stopped ? { text: `${stopped}${counts}`, tone: event.stop === "stopped" ? undefined : "warn" } : { text: t().officialDone(counts) };
      return;
    }
    const written = t().written(tally.written, tally.failed);
    status.value =
      event.stop === "stopped"
        ? { text: t().verdictStopped(written) }
        : { text: t().verdictDone(written), ...(tally.failed ? { tone: "warn" as const } : {}) };
    // 别处同时写好的、停止时还在路上后来写好的，都从本机重新读一次。
    void load();
  }

  function onEvent(event: PortEvent<"batch">): void {
    switch (event.type) {
      case "triage.started": {
        running.value = event.step;
        runningTotal = event.total;
        if (event.step !== "list") {
          const verb = event.step === "official" ? t().fetching : t().writing;
          statusOf(event.step).value = { text: event.joined ? t().joined(verb) : t().progress(verb, 0, event.total) };
        }
        return;
      }
      case "triage.item":
        return onItem(event);
      case "triage.done":
        return onDone(event);
      case "triage.refused":
        if (running.peek() === event.step) running.value = null;
        statusOf(event.step).value = { text: failureText(event.failure), tone: "error" };
        return;
      case "port.error":
        statusOf(running.peek() ?? "list").value = { text: describe(event.code, undefined, lang()), tone: "error" };
        return;
      default:
        // 本窗口全部生成的消息不归这一页。
        return;
    }
  }

  function ensurePort(): PagePort<"batch"> {
    if (port?.isOpen()) return port;
    port = api.connect("batch", {
      onEvent,
      onClose(code) {
        port = null;
        const step = running.peek();
        if (step) statusOf(step).value = { text: t().stepStopped(describe(code, undefined, lang())), tone: "error" };
        running.value = null;
        stopping.value = false;
      },
    });
    return port;
  }

  function start(step: TriageStep): void {
    if (running.peek()) return;
    running.value = step;
    if (step === "verdict") tally = { written: 0, failed: 0 };
    if (step === "list") listStatus.value = { text: t().listReading };
    const sent = ensurePort().post({ type: "triage.start", step });
    if (!sent) {
      running.value = null;
      statusOf(step).value = { text: t().noBackground, tone: "error" };
    }
  }

  function askOfficial(): void {
    if (running.peek()) return;
    const list = items.peek();
    const todo = officialTodo(list, current().official);
    if (!todo.length) {
      officialStatus.value = { text: t().nothingToFetch(officialCounts(list, current().official, lang())) };
      return;
    }
    const skipped = list.length - todo.length;
    const minutes = Math.max(1, Math.ceil((todo.length * OFFICIAL_INTERVAL_MS) / 60_000));
    const ask = t().askOfficial;
    pending.value = { step: "official", lines: [ask.request(todo.length, skipped), ask.cost(minutes), ask.stop] };
  }

  async function askVerdicts(): Promise<void> {
    if (running.peek()) return;
    const list = items.peek();
    const { official, verdicts } = current();
    const todo = verdictTodo(list, official, verdicts);
    if (!todo.length) {
      const anyOfficial = list.some((item) => hasOfficialContent(official[item.videoKey]));
      verdictStatus.value = { text: anyOfficial ? t().allWritten : t().noneToWrite };
      return;
    }
    const config = await api.send("config.check", {});
    if (!config.ok || !config.value.ready) {
      verdictStatus.value = { text: config.ok ? t().notConfigured : describe(config.code, config.detail, lang()), tone: "error" };
      return;
    }
    const withVerdict = list.filter((item) => hasVerdict(verdicts[item.videoKey])).length;
    const withoutOfficial = list.filter((item) => !hasVerdict(verdicts[item.videoKey]) && !hasOfficialContent(official[item.videoKey])).length;
    const ask = t().askVerdict;
    pending.value = {
      step: "verdict",
      lines: [
        ask.count(todo.length),
        ask.cost(AI_CONCURRENCY),
        ...(withVerdict ? [ask.skipWritten(withVerdict)] : []),
        ...(withoutOfficial ? [ask.skipNoOfficial(withoutOfficial)] : []),
      ],
    };
  }

  return {
    snapshot,
    loadFailure,
    running,
    stopping,
    pending,
    listStatus,
    officialStatus,
    verdictStatus,
    errors,
    filter,
    items,
    videoUrl: deps.videoUrl,
    load,
    readList: () => start("list"),
    askOfficial,
    askVerdicts,
    confirm() {
      const ask = pending.peek();
      pending.value = null;
      if (ask) start(ask.step);
    },
    cancel() {
      pending.value = null;
    },
    stop() {
      if (!running.peek() || stopping.peek() || !port?.isOpen()) return;
      stopping.value = true;
      port.post({ type: "triage.stop" });
      const step = running.peek();
      if (step === "verdict") verdictStatus.value = { text: t().verdictStopping };
      if (step === "official") officialStatus.value = { text: t().officialStopping };
    },
    setFilter(next) {
      filter.value = next;
    },
    exportMarkdown() {
      const { list, official, verdicts } = current();
      if (!list?.items.length) return;
      const at = now();
      const first = list.items[0];
      const text = toMarkdown({ items: list.items, official, verdicts, exportedAt: at }, first ? deps.videoBase(first.videoKey) : "", lang());
      deps.download(exportFileName(at, lang()), text);
    },
    cleared() {
      port?.close();
      port = null;
      running.value = null;
      stopping.value = false;
      pending.value = null;
      errors.value = {};
      apply(EMPTY);
      officialStatus.value = null;
      verdictStatus.value = null;
      listStatus.value = { text: t().cleared };
    },
    dispose() {
      port?.close();
      port = null;
    },
  };
}
