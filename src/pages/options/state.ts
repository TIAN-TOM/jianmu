// 设置页的状态和动作：设置直接经设置仓库读写（排在同一把锁里，密钥不落盘），拉模型、测试连接、备份和清除发给后台。
// 主机权限的申请要在用户点击的同一个调用栈里发起，所以保存先同步发起申请，再等别的。
import { signal, type ReadonlySignal } from "@preact/signals";
import { backupText, readBackup } from "../../core/backup/format.ts";
import type { ClearScope } from "../../core/clear-guard.ts";
import { describe, isErrorCode, type Failure } from "../../core/errors.ts";
import { isLocalBaseUrl } from "../../core/ai/provider/index.ts";
import { AI_ERROR_TEXT } from "../../core/errors/ai.ts";
import type { LoadedSettings, SettingsPatch, SettingsStore, WrittenSettings } from "../../platform/settings-store.ts";
import type { EffortPreviewItem } from "../../shared/messages/ai.ts";
import { SETTINGS_REVISION_KEY, SETTINGS_STORAGE_KEY, USAGE_STORAGE_KEY } from "../../shared/names.ts";
import { originOf, validateForSave, type FeatureSlotId } from "../../shared/settings-schema.ts";
import type { PageApi } from "../shared/api.ts";
import { createAiStatus, type AiPlace, type PlacedStatus, type Status } from "./ai-status.ts";
import { backupFailureText, importSummary, receiveBackup, sendBackup } from "./backup-transfer.ts";
import { chosenFeatures, formOf, settingsInput, withAddress, withPreset, type AiForm } from "./form.ts";
import { probeFrameImage } from "./image-probe.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { slotLabel, textOf } from "./text.ts";

export type { AiPlace, PlacedStatus, Status, Tone } from "./ai-status.ts";

/** 正在做的事，同一时间只做一件，按钮据此停用。 */
export type Busy = "save" | "models" | "test" | "export" | "import" | "clear" | null;

type StorageListener = (changes: object, area: string) => void;

export interface OptionsDeps {
  readonly store: Pick<SettingsStore, "load" | "save" | "update" | "setDataConsent">;
  readonly api: Pick<PageApi, "send" | "connect">;
  /** 申请一条主机权限；必须在点击的同步调用栈里调用。 */
  readonly requestHost: (pattern: string) => Promise<boolean>;
  /** 把备份存成文件：文本按块给，拼起来就是文件内容。 */
  readonly download: (filename: string, chunks: readonly string[]) => void;
  readonly storageChanged?: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
  readonly now?: () => Date;
  /** 状态行用哪种语言写，缺省中文。页面传当前的界面语言。 */
  readonly lang?: () => UiLang;
}

export interface OptionsState {
  readonly saved: ReadonlySignal<LoadedSettings | null>;
  readonly form: ReadonlySignal<AiForm | null>;
  readonly loadError: ReadonlySignal<string | null>;
  /** 「AI 服务」一节同一时间只有一条状态，at 说它显示在哪个控件下面。 */
  readonly aiStatus: ReadonlySignal<PlacedStatus | null>;
  readonly autoStatus: ReadonlySignal<Status | null>;
  readonly dataStatus: ReadonlySignal<Status | null>;
  readonly busy: ReadonlySignal<Busy>;
  readonly models: ReadonlySignal<readonly string[]>;
  /** 每项功能实际生效的推理档位，后台按已保存的服务、模型和档位算；问不到时是 null。 */
  readonly efforts: ReadonlySignal<readonly EffortPreviewItem[] | null>;
  load(): Promise<void>;
  edit(patch: Partial<Pick<AiForm, "aiModel" | "rememberApiKey">>): void;
  editKey(key: string): void;
  editFeatureModel(id: FeatureSlotId, model: string): void;
  /** 重问实际档位，只在本机算，不发模型请求。 */
  refreshEfforts(): Promise<void>;
  choosePreset(presetId: string): void;
  editAddress(patch: Pick<AiForm, "aiBaseUrl"> | Pick<AiForm, "protocol">): void;
  save(): Promise<boolean>;
  /** 即改即存：不等「保存并授权」，也不申请权限。推理强度存好以后重问实际档位。 */
  saveInstant(patch: SettingsPatch): Promise<void>;
  setConsent(given: boolean): Promise<void>;
  /** 打开就出结论：先同意当前的数据说明，同意存上了才打开开关。 */
  enableAuto(): Promise<void>;
  setRemember(remember: boolean): Promise<void>;
  clearKey(): Promise<void>;
  fetchModels(): Promise<void>;
  testConnection(all: boolean): Promise<void>;
  /** 探一次画面分析的模型能不能看图（只在构建开关打开时有这个按钮）。 */
  probeImage(): Promise<void>;
  exportBackup(): Promise<void>;
  /** read 读出所选文件的文字，读不出来时给一句说明。 */
  importBackup(read: () => Promise<string>): Promise<void>;
  clearData(scope: ClearScope): Promise<void>;
  stop(): void;
}

/** 后台回来的失败给用户看的一句话：模型服务的失败带着脱敏后的原话，其余按码。 */
export function failureText(failure: Failure, lang: UiLang = "zh"): string {
  if (Object.hasOwn(AI_ERROR_TEXT, failure.code) && failure.detail) return failure.detail;
  return describe(failure.code, failure.detail, lang);
}

const errorTextIn = (error: unknown, lang: UiLang): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (isErrorCode(code)) return describe(code, undefined, lang);
  return error instanceof Error ? error.message : String(error);
};

const isStale = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "SETTINGS_STALE";

const pad = (value: number): string => String(value).padStart(2, "0");

export function createOptionsState(deps: OptionsDeps): OptionsState {
  const { store, api } = deps;
  const lang = deps.lang ?? ((): UiLang => "zh");
  const copy = () => textOf(lang());
  const status = () => copy().status;
  const failText = (failure: Failure): string => failureText(failure, lang());
  const errorText = (error: unknown): string => errorTextIn(error, lang());
  const saved = signal<LoadedSettings | null>(null);
  const form = signal<AiForm | null>(null);
  const loadError = signal<string | null>(null);
  const ai = createAiStatus(lang);
  const { say, saySaved } = ai;
  const aiStatus = ai.current;
  const autoStatus = signal<Status | null>(null);
  const dataStatus = signal<Status | null>(null);
  const busy = signal<Busy>(null);
  const models = signal<readonly string[]>([]);
  const efforts = signal<readonly EffortPreviewItem[] | null>(null);
  // 表单打开时的修订号：保存时在锁里核对，即改即存后比对，别的页面改过就重新载入。
  let revision = "";
  let ownWrites = 0;
  let stopped = false;

  async function load(): Promise<void> {
    try {
      const settings = await store.load();
      if (stopped) return;
      revision = settings.settingsRevision;
      saved.value = settings;
      form.value = formOf(settings);
      loadError.value = null;
      void refreshEfforts();
      const check = validateForSave(settings, lang());
      if (!check.ok) say("actions", check.errors.join(" "), "error");
      // 同意过数据说明、要密钥的服务却没有密钥：多半是重启或更新以后清空了，打开设置页就在密钥框下面说，不用自己找原因。
      else if (settings.dataConsentVersion > 0 && !settings.aiApiKey && !isLocalBaseUrl(settings.aiBaseUrl)) ai.sayKeyMissing();
    } catch (error) {
      loadError.value = copy().loadFailedDetail(errorText(error));
    }
  }

  // 按存储重新载入过几次：保存在授权弹窗之后、排完队时比一下，期间重新载入过，点击时的表单就作废了。
  let reloads = 0;

  async function reloadStale(at: AiPlace = "actions"): Promise<void> {
    reloads += 1;
    models.value = [];
    await load();
    say(at, status().stale, "warn");
  }

  // 本页自己的设置写入排成一条队：前一次（比如刚勾的同意）还没落地就点保存，保存要等它写完、拿它之后的修订号去核对。
  let ownQueue: Promise<unknown> = Promise.resolve();
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const run = ownQueue.then(work, work);
    ownQueue = run.catch(() => undefined);
    return run;
  }

  /** 自己写设置：写的途中自己引起的修订号变化不算别的页面改的。at 是别的页面改过、要重新载入时那句提示的落点。 */
  const ownWrite = (write: () => Promise<WrittenSettings>, at: AiPlace = "actions"): Promise<WrittenSettings | null> => queued(async () => {
    ownWrites += 1;
    try {
      const written = await write();
      if (written.previousRevision !== revision) {
        await reloadStale(at);
        return null;
      }
      revision = written.settingsRevision;
      saved.value = written;
      return written;
    } finally {
      ownWrites -= 1;
    }
  });

  // 别处改了即改即存的几项（修订号不变，比如从工具栏图标的右键菜单开关）：把存着的值读回来，页面上的开关跟着变，
  // 表单上还没保存的不动。排在本页自己的写入后面，读到的不会比本页刚写的旧。
  const refreshSaved = (): Promise<void> =>
    queued(async () => {
      const settings = await store.load().catch(() => null);
      if (!settings || stopped) return;
      if (settings.settingsRevision !== revision) return reloadStale();
      saved.value = settings;
    });

  const onStorage: StorageListener = (changes, area) => {
    const record = changes as Record<string, { newValue?: unknown } | undefined>;
    // 别的页面发的请求记下了用量，或者清除删掉了它：推理强度那一节跟着重问。
    if (!stopped && area === "session" && record[USAGE_STORAGE_KEY]) void refreshEfforts();
    if (stopped || area !== "local" || ownWrites > 0) return;
    const change = record[SETTINGS_REVISION_KEY];
    if (change && (change.newValue ?? "") !== revision) void reloadStale();
    else if (record[SETTINGS_STORAGE_KEY]) void refreshSaved();
  };
  deps.storageChanged?.addListener(onStorage);

  const setForm = (next: AiForm): void => {
    form.value = next;
  };

  // 连着改档位时回复可能乱序，只认最后一问。
  let effortAsk = 0;
  async function refreshEfforts(): Promise<void> {
    const current = saved.peek();
    if (!current || stopped) return;
    const ask = ++effortAsk;
    const reply = await api.send("ai.effortPreview", { efforts: { ...current.featureEfforts } }).catch(() => null);
    if (ask !== effortAsk || stopped) return;
    efforts.value = reply?.ok && Array.isArray(reply.value.items) ? reply.value.items : null;
  }

  /** at：这次保存的结果写在哪。拉模型、测试连接、看图检测先保存一次，没存成的原因写在点的那个按钮旁边。 */
  async function save(at: AiPlace = "actions"): Promise<boolean> {
    const current = form.peek();
    const before = saved.peek();
    if (!current || !before || busy.peek()) return false;
    // 按点击那一刻的表单保存。修订号用本页排在前面的写入落地之后的；授权弹窗期间别的页面清过密钥或全部数据，
    // 这次保存作废，不把清掉的写回去。
    const input = settingsInput(current, before);
    const check = validateForSave(input, lang());
    const origin = check.ok ? originOf(check.settings.aiBaseUrl) : null;
    if (!check.ok || !origin) {
      say(at, check.errors.join(" ") || status().badAddress, "error");
      return false;
    }
    const asked = deps.requestHost(`${origin}*`);
    const reloadsAtClick = reloads;
    busy.value = "save";
    // 按钮写着「正在保存」的时候，下面不留上一次的「已保存」：授权弹窗可能开着一阵。
    ai.clear();
    try {
      let granted = false;
      try {
        granted = await asked;
      } catch (error) {
        say(at, status().permissionFailed(errorText(error)), "error");
        return false;
      }
      if (!granted) {
        say(at, status().noPermission(origin), "error");
        return false;
      }
      const written = await queued(async () => {
        // 等授权、排队的工夫别的页面改过设置（比如清了密钥），表单已经按存储重新载入：点击时的表单不能再写回去。
        if (reloads !== reloadsAtClick) {
          say(at, status().stale, "warn");
          return null;
        }
        ownWrites += 1;
        try {
          // 表单上没有的字段（同意、外观、推理强度、概览分块）用排在前面的写入落地之后的设置补全，不拿点击时的旧值盖回去。
          const result = await store.save(settingsInput(current, saved.peek() ?? before), revision);
          revision = result.settingsRevision;
          saved.value = result;
          return result;
        } catch (error) {
          if (isStale(error)) await reloadStale(at);
          else say(at, status().notSaved(errorText(error)), "error");
          return null;
        } finally {
          ownWrites -= 1;
        }
      });
      if (!written) return false;
      form.value = formOf(written);
      void refreshEfforts();
      // 回收是尽力而为：失败只是多留几条授权。
      await api.send("grants.release", {});
      saySaved(at, written);
      return true;
    } finally {
      busy.value = null;
    }
  }

  async function saveInstant(patch: SettingsPatch): Promise<void> {
    // 推理强度和概览分块在「AI 服务」一节里有自己的位置，别的设置没存上照旧写在按钮下面。
    const at: AiPlace = Object.hasOwn(patch, "featureEfforts") ? "efforts" : Object.hasOwn(patch, "analysisChunkMode") ? "chunk" : "actions";
    try {
      const written = await ownWrite(() => store.update(patch), at);
      if (written && Object.hasOwn(patch, "featureEfforts")) void refreshEfforts();
    } catch (error) {
      say(at, status().notSaved(errorText(error)), "error");
    }
  }

  /** 测一个模型，回状态行里的一行和连没连上。 */
  async function testOne(feature?: FeatureSlotId): Promise<{ readonly line: string; readonly ok: boolean }> {
    const reply = await api.send("ai.testConnection", feature ? { feature } : {});
    const label = feature ? slotLabel(feature, lang()) : copy().ai.defaultModel;
    if (!reply.ok) return { line: status().testFailed(label, failText(reply)), ok: false };
    const { model, reply: answer, truncated } = reply.value;
    return { line: status().connected(label, model, answer, truncated === true), ok: true };
  }

  /** 拉模型和测试连接用后台存着的设置：先按点击时的表单保存，存成了再发。at 是点的那个按钮的位置。 */
  async function afterSave(kind: "models" | "test", at: AiPlace, work: () => Promise<void>): Promise<void> {
    if (!(await save(at))) return;
    busy.value = kind;
    try {
      await work();
    } finally {
      busy.value = null;
      // 拉到的模型能力、测试时服务拒掉的参数都会改变实际档位。
      void refreshEfforts();
    }
  }

  return {
    saved,
    form,
    loadError,
    aiStatus,
    autoStatus,
    dataStatus,
    busy,
    models,
    efforts,
    load,
    edit(patch) {
      const current = form.peek();
      if (current) setForm({ ...current, ...patch });
    },
    editKey(key) {
      const current = form.peek();
      if (current) setForm({ ...current, aiApiKey: key, keyTyped: true });
      ai.keyTyped();
    },
    editFeatureModel(id, model) {
      const current = form.peek();
      if (current) setForm({ ...current, featureModels: { ...current.featureModels, [id]: model } });
    },
    refreshEfforts,
    choosePreset(presetId) {
      const current = form.peek();
      const before = saved.peek();
      if (!current || !before) return;
      models.value = [];
      setForm(withPreset(current, presetId, before));
    },
    editAddress(patch) {
      const current = form.peek();
      const before = saved.peek();
      if (!current || !before) return;
      models.value = [];
      setForm(withAddress(current, patch, before));
    },
    save,
    saveInstant,
    async setConsent(given) {
      try {
        const written = await ownWrite(() => store.setDataConsent(given));
        if (written) ai.consentChanged(written);
      } catch (error) {
        say("actions", status().notSaved(errorText(error)), "error");
      }
    },
    async enableAuto() {
      try {
        const consented = await ownWrite(() => store.setDataConsent(true));
        if (!consented) return;
        const written = await ownWrite(() => store.update({ autoOverview: true }));
        autoStatus.value = written ? null : { text: status().stale, tone: "warn" };
      } catch (error) {
        autoStatus.value = { text: copy().auto.notOn(errorText(error)), tone: "error" };
      }
    },
    async setRemember(remember) {
      const current = form.peek();
      if (!current) return;
      setForm({ ...current, rememberApiKey: remember });
      if (remember) {
        say("remember", status().rememberAfterSave, "warn");
        return;
      }
      try {
        const written = await ownWrite(() => store.update({ rememberApiKey: false }), "remember");
        if (written) say("remember", status().rememberOff, "ok");
      } catch (error) {
        setForm({ ...current, rememberApiKey: true });
        say("remember", status().rememberOffFailed(errorText(error)), "error");
      }
    },
    async clearKey() {
      try {
        const written = await ownWrite(() => store.update({ aiApiKey: "" }), "key");
        if (!written) return;
        const current = form.peek();
        if (current) setForm({ ...current, aiApiKey: "", keyTyped: false, rememberApiKey: false });
        say("key", status().keyCleared, "ok");
      } catch (error) {
        say("key", status().keyClearFailed(errorText(error)), "error");
      }
    },
    fetchModels: () =>
      afterSave("models", "model", async () => {
        const reply = await api.send("models.list", {});
        if (!reply.ok) {
          say("model", status().modelsFailed(failText(reply)), "error");
          return;
        }
        models.value = reply.value.ids;
        const written = saved.peek();
        if (written) ai.sayFetched("model", written, reply.value.ids);
      }),
    testConnection: (all) =>
      afterSave("test", "actions", async () => {
        const current = form.peek();
        const features = all && current ? chosenFeatures(current) : [];
        const results = [await testOne()];
        for (const feature of features) results.push(await testOne(feature));
        say("actions", results.map(({ line }) => line).join("\n"), results.every(({ ok }) => ok) ? "ok" : "error");
      }),
    probeImage: FEATURE_FRAME_EXPLAIN
      ? () =>
          afterSave("test", "probe", async () => {
            const probed = await probeFrameImage(api, failText, lang());
            say("probe", probed.text, probed.tone);
          })
      : async () => undefined,
    async exportBackup() {
      if (busy.peek()) return;
      busy.value = "export";
      try {
        const reply = await receiveBackup(api);
        if (!reply.ok) {
          dataStatus.value = { text: backupFailureText(reply, "export", failText, lang()), tone: "error" };
          return;
        }
        const date = (deps.now ?? (() => new Date()))();
        const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        deps.download(copy().backup.fileName(stamp), backupText(reply.value));
        const { notes, overviews, qa, translations } = reply.value;
        const counts = { notes: notes.length, overviews: overviews.length, qa: qa.length, translations: translations.length };
        dataStatus.value = { text: copy().backup.exported(counts), tone: "ok" };
      } finally {
        busy.value = null;
      }
    },
    async importBackup(readFile) {
      if (busy.peek()) return;
      // 读文件之前就占住：大文件要读一会儿，这期间不能再点导出、清除或另一次导入。
      busy.value = "import";
      try {
        let text: string;
        try {
          text = await readFile();
        } catch {
          dataStatus.value = { text: copy().backup.unreadable, tone: "error" };
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          dataStatus.value = { text: copy().backup.notBackup, tone: "error" };
          return;
        }
        const read = readBackup(payload);
        if (!read.ok) {
          dataStatus.value = { text: copy().backup.importFailed(failText(read)), tone: "error" };
          return;
        }
        const reply = await sendBackup(api, read.value);
        dataStatus.value = reply.ok ? { text: importSummary(reply.value, lang()), tone: "ok" } : { text: backupFailureText(reply, "import", failText, lang()), tone: "error" };
      } finally {
        busy.value = null;
      }
    },
    async clearData(scope) {
      if (busy.peek()) return;
      busy.value = "clear";
      ownWrites += 1;
      try {
        const reply = await api.send("data.clear", { scope });
        if (!reply.ok) {
          dataStatus.value = { text: copy().backup.clearFailed(failText(reply)), tone: "error" };
          return;
        }
        if (scope === "all") {
          models.value = [];
          await load();
          ai.clear();
          dataStatus.value = { text: copy().backup.clearedAll, tone: "ok" };
          return;
        }
        dataStatus.value = { text: copy().backup.clearedCache, tone: "ok" };
      } finally {
        ownWrites -= 1;
        busy.value = null;
      }
    },
    stop() {
      stopped = true;
      deps.storageChanged?.removeListener(onStorage);
    },
  };
}
