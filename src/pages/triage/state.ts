// 粗筛页的状态和动作。三步都经长连接 batch 交给后台做：读列表、逐个取官方总结、写一句话结论；后台做完一个推一个。
// 页面开着连接就开着，关掉页面连接断开，后台撤掉还在排队的。开始前就地确认，写清数量、跳过规则和费用。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import { hasOfficialContent, isOfficialDone, OFFICIAL_INTERVAL_MS, officialTodo, verdictTodo } from "../../core/triage/batch.ts";
import { formatDateTime, toMarkdown } from "../../core/triage/export.ts";
import { hasVerdict, type GroupKey } from "../../core/triage/groups.ts";
import type { OfficialRecord, TriageItem } from "../../core/triage/state.ts";
import type { PortEvent } from "../../shared/messages.ts";
import type { BatchFailure, TriageOut, TriageSnapshot, TriageStep, TriageStop } from "../../shared/messages/batch.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import type { PageApi, PagePort } from "../shared/api.ts";

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
}

export interface TriageState {
  /** 还没问到是 null。 */
  readonly snapshot: ReadonlySignal<TriageSnapshot | null>;
  readonly loadFailure: ReadonlySignal<string | null>;
  /** 后台正在跑的一步：这一页发起的，或者别的页面发起、这一页接上的。 */
  readonly running: ReadonlySignal<TriageStep | null>;
  readonly stopping: ReadonlySignal<boolean>;
  readonly pending: ReadonlySignal<Pending | null>;
  readonly listStatus: ReadonlySignal<Status | null>;
  readonly officialStatus: ReadonlySignal<Status | null>;
  readonly verdictStatus: ReadonlySignal<Status | null>;
  /** 这一次打开页面里写结论失败的原因，只显示，不存。 */
  readonly errors: ReadonlySignal<Readonly<Record<string, string>>>;
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

/** 官方总结没取成的原因：被限流单说一句，别的照错误码的说明。 */
export function officialRecordText(record: OfficialRecord | undefined, item: TriageItem): string {
  if (item.available === false) return "视频已失效或暂时看不了，没有去取官方总结";
  if (!record) return "还没取官方总结";
  if (record.status === "ok" && !hasOfficialContent(record)) return "没有官方总结";
  switch (record.status) {
    case "none":
      return "没有官方总结";
    case "queued":
      return "B 站还在生成总结，过几分钟再点开始";
    case "unsupported":
      return "B 站不给这个视频做总结";
    case "need-login":
      return "要先在这个浏览器里登录 B 站";
    default:
      if (record.reason === "RATE_LIMITED") return "被 B 站限流了，过几分钟再点开始会重试";
      return `没取到：${describe((record.reason ?? "BACKGROUND_FAILED") as ErrorCode)}再点开始会重试`;
  }
}

/** 第一步取完以后的分类计数。 */
export function officialCounts(items: readonly TriageItem[], official: Readonly<Record<string, OfficialRecord | undefined>>): string {
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
  const parts = [`有官方总结 ${ok} 个`];
  if (none) parts.push(`没有 ${none} 个`);
  if (later) parts.push(`这次没取到 ${later} 个`);
  if (pending) parts.push(`还没取 ${pending} 个`);
  return `${parts.join("，")}。`;
}

export function listSummary(snapshot: TriageSnapshot): string {
  const list = snapshot.list;
  if (!list) return "";
  const parts = [`共 ${list.items.length} 个视频，读取于 ${formatDateTime(list.fetchedAt)}。`];
  if (list.count > list.items.length) parts.push(`B 站报的总数是 ${list.count} 个，读到的只有 ${list.items.length} 个。`);
  const unavailable = list.items.filter((item) => item.available === false).length;
  if (unavailable) parts.push(`其中 ${unavailable} 个已失效或暂时看不了，不会去取官方总结。`);
  return parts.join("");
}

function stopText(stop: TriageStop | undefined, done: number, total: number, again: string): string | null {
  const tally = `（处理了 ${done} / ${total} 个）`;
  switch (stop) {
    case "rate-limited":
      return `被 B 站限流，已经停下${tally}。过几分钟再点开始，${again}`;
    case "need-login":
      return `B 站说要先登录，已经停下${tally}。在这个浏览器里登录 B 站后再点开始，${again}`;
    case "source":
      return `B 站回的内容读不懂，已经停下${tally}。过一阵再试，${again}`;
    case "stopped":
      return `已停止${tally}，再点开始${again}`;
    default:
      return null;
  }
}

const failureText = (failure: BatchFailure): string => describe(failure.code);

export function createTriageState(deps: TriageDeps): TriageState {
  const { api } = deps;
  const now = deps.now ?? Date.now;
  const snapshot = signal<TriageSnapshot | null>(null);
  const loadFailure = signal<string | null>(null);
  const running = signal<TriageStep | null>(null);
  const stopping = signal(false);
  const pending = signal<Pending | null>(null);
  const listStatus = signal<Status | null>(null);
  const officialStatus = signal<Status | null>(null);
  const verdictStatus = signal<Status | null>(null);
  const errors = signal<Readonly<Record<string, string>>>({});
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
      loadFailure.value = describe(reply.code, reply.detail);
      return;
    }
    loadFailure.value = null;
    apply(reply.value);
    if (reply.value.list) {
      listStatus.value = { text: `${listSummary(reply.value)}要看最新的列表就再读取一次。` };
      officialStatus.value = { text: officialCounts(reply.value.list.items, reply.value.official) };
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
        errors.value = { ...errors.peek(), [event.video]: `结论没写成：${failureText(event.failure)}` };
      }
    }
    if (!stopping.peek()) statusOf(event.step).value = { text: `${event.step === "official" ? "正在取" : "正在写"} ${event.done} / ${runningTotal}…` };
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
      const dropped = event.dropped ? `另有 ${event.dropped} 项不是第 1 P 或读不出视频号，没有列出。` : "";
      status.value = { text: `${listSummary(current())}${dropped}` };
      officialStatus.value = { text: officialCounts(items.peek(), current().official) };
      return;
    }
    if (event.failure && event.failure.code === "TRIAGE_LIST_CLEARED") {
      status.value = { text: failureText(event.failure), tone: "error" };
      void load();
      return;
    }
    if (event.step === "official") {
      const counts = officialCounts(items.peek(), current().official);
      const stopped = stopText(event.stop, event.done, event.total, "会接着取剩下的。");
      status.value = stopped ? { text: `${stopped}${counts}`, tone: event.stop === "stopped" ? undefined : "warn" } : { text: `这一轮取完了。${counts}` };
      return;
    }
    const written = `写好 ${tally.written} 个${tally.failed ? `，失败 ${tally.failed} 个` : ""}。`;
    status.value =
      event.stop === "stopped"
        ? { text: `已停止，${written}再点开始会接着写剩下的。` }
        : { text: `这一轮写完了，${written}`, ...(tally.failed ? { tone: "warn" as const } : {}) };
    // 别处同时写好的、停止时还在路上后来写好的，都从本机重新读一次。
    void load();
  }

  function onEvent(event: PortEvent<"batch">): void {
    switch (event.type) {
      case "triage.started": {
        running.value = event.step;
        runningTotal = event.total;
        if (event.step !== "list") {
          const verb = event.step === "official" ? "正在取" : "正在写";
          statusOf(event.step).value = { text: event.joined ? `接上了另一页正在做的这一步：${verb}…` : `${verb} 0 / ${event.total}…` };
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
        statusOf(running.peek() ?? "list").value = { text: describe(event.code), tone: "error" };
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
        if (step) statusOf(step).value = { text: `和后台的连接断了，这一步停下了：${describe(code)}`, tone: "error" };
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
    if (step === "list") listStatus.value = { text: "正在读取…" };
    const sent = ensurePort().post({ type: "triage.start", step });
    if (!sent) {
      running.value = null;
      statusOf(step).value = { text: "没能连上后台，刷新这一页再试。", tone: "error" };
    }
  }

  function askOfficial(): void {
    if (running.peek()) return;
    const list = items.peek();
    const todo = officialTodo(list, current().official);
    if (!todo.length) {
      officialStatus.value = { text: `没有要取的了。${officialCounts(list, current().official)}` };
      return;
    }
    const skipped = list.length - todo.length;
    const minutes = Math.max(1, Math.ceil((todo.length * OFFICIAL_INTERVAL_MS) / 60_000));
    pending.value = {
      step: "official",
      lines: [
        `要逐个请求 ${todo.length} 个视频的 B 站官方总结${skipped ? `，跳过已经有结果或已失效的 ${skipped} 个` : ""}。`,
        `不调模型，不花 API 额度。一次一个，每两次请求之间至少隔 1.5 秒，大约要 ${minutes} 分钟以上。`,
        "可以随时停止；关掉这个页面也会停止。",
      ],
    };
  }

  async function askVerdicts(): Promise<void> {
    if (running.peek()) return;
    const list = items.peek();
    const { official, verdicts } = current();
    const todo = verdictTodo(list, official, verdicts);
    if (!todo.length) {
      const anyOfficial = list.some((item) => hasOfficialContent(official[item.videoKey]));
      verdictStatus.value = { text: anyOfficial ? "有官方总结的视频都已经有结论了。" : "还没有可以写结论的视频：先做第一步取官方总结。" };
      return;
    }
    const config = await api.send("config.check", {});
    if (!config.ok || !config.value.ready) {
      verdictStatus.value = { text: config.ok ? "还没配置好 AI 服务：先到设置页填好服务商、密钥和模型。" : describe(config.code, config.detail), tone: "error" };
      return;
    }
    const withVerdict = list.filter((item) => hasVerdict(verdicts[item.videoKey])).length;
    const withoutOfficial = list.filter((item) => !hasVerdict(verdicts[item.videoKey]) && !hasOfficialContent(official[item.videoKey])).length;
    pending.value = {
      step: "verdict",
      lines: [
        `要给 ${todo.length} 个有官方总结的视频写一句话结论。`,
        `会用到你的 API 额度：每个视频发一次小请求，把标题、简介、UP 主名、时长和官方总结发给你设置的模型服务，不含字幕，同时最多 ${AI_CONCURRENCY} 个。`,
        ...(withVerdict ? [`已经有结论的 ${withVerdict} 个会跳过。`] : []),
        ...(withoutOfficial ? [`没有官方总结的 ${withoutOfficial} 个不在这里写。`] : []),
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
      if (step === "verdict") verdictStatus.value = { text: "正在停止：不再开始新的，等已经发出去的请求回来…" };
      if (step === "official") officialStatus.value = { text: "正在停止：等进行中的那一个请求回来…" };
    },
    setFilter(next) {
      filter.value = next;
    },
    exportMarkdown() {
      const { list, official, verdicts } = current();
      if (!list?.items.length) return;
      const at = now();
      const first = list.items[0];
      const text = toMarkdown({ items: list.items, official, verdicts, exportedAt: at }, first ? deps.videoBase(first.videoKey) : "");
      deps.download(`简幕-稍后再看-${formatDateTime(at).replace(/[-: ]/g, "")}.md`, text);
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
      listStatus.value = { text: "设置页清除了本机数据，要用的话重新读取稍后再看。" };
    },
    dispose() {
      port?.close();
      port = null;
    },
  };
}
