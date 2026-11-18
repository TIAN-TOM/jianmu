// 设置页的状态和动作：设置直接经设置仓库读写（排在同一把锁里，密钥不落盘），拉模型、测试连接、备份和清除发给后台。
// 主机权限的申请要在用户点击的同一个调用栈里发起，所以保存先同步发起申请，再等别的。
import { signal, type ReadonlySignal } from "@preact/signals";
import { backupText, readBackup } from "../../core/backup/format.ts";
import type { ClearScope } from "../../core/clear-guard.ts";
import { describe, isErrorCode, type Failure } from "../../core/errors.ts";
import { AI_ERROR_TEXT } from "../../core/errors/ai.ts";
import type { Effort } from "../../core/notes/records.ts";
import type { LoadedSettings, SettingsPatch, SettingsStore, WrittenSettings } from "../../platform/settings-store.ts";
import type { EffortPreviewItem } from "../../shared/messages/ai.ts";
import { SETTINGS_REVISION_KEY } from "../../shared/names.ts";
import { FEATURE_MODEL_SLOTS, originOf, validate, validateForSave, type FeatureSlotId } from "../../shared/settings-schema.ts";
import type { PageApi } from "../shared/api.ts";
import { importSummary, receiveBackup, sendBackup } from "./backup-transfer.ts";
import { chosenFeatures, formOf, settingsInput, withAddress, withPreset, type AiForm } from "./form.ts";
import { probeFrameImage } from "./image-probe.ts";

export type Tone = "ok" | "warn" | "error";

export interface Status {
  readonly text: string;
  readonly tone: Tone;
}

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
}

export interface OptionsState {
  readonly saved: ReadonlySignal<LoadedSettings | null>;
  readonly form: ReadonlySignal<AiForm | null>;
  readonly loadError: ReadonlySignal<string | null>;
  readonly aiStatus: ReadonlySignal<Status | null>;
  readonly autoStatus: ReadonlySignal<Status | null>;
  readonly dataStatus: ReadonlySignal<Status | null>;
  readonly busy: ReadonlySignal<Busy>;
  readonly models: ReadonlySignal<readonly string[]>;
  /** 每项功能实际生效的推理档位，后台按已保存的服务和模型、表单上选的档位算；问不到时是 null。 */
  readonly efforts: ReadonlySignal<readonly EffortPreviewItem[] | null>;
  load(): Promise<void>;
  edit(patch: Partial<Pick<AiForm, "aiModel" | "analysisChunkMode" | "rememberApiKey">>): void;
  editKey(key: string): void;
  editFeatureModel(id: FeatureSlotId, model: string): void;
  editEffort(id: FeatureSlotId, effort: Effort): void;
  /** 重问实际档位，只在本机算，不发模型请求。 */
  refreshEfforts(): Promise<void>;
  choosePreset(presetId: string): void;
  editAddress(patch: Pick<AiForm, "aiBaseUrl"> | Pick<AiForm, "protocol">): void;
  save(): Promise<boolean>;
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

const STALE_TEXT = "设置刚在别的页面改过，已按最新的设置重新载入，请再操作一次。";

/** 后台回来的失败给用户看的一句话：模型服务的失败带着脱敏后的原话，其余按码。 */
export function failureText(failure: Failure): string {
  if (Object.hasOwn(AI_ERROR_TEXT, failure.code) && failure.detail) return failure.detail;
  return describe(failure.code, failure.detail);
}

const errorText = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (isErrorCode(code)) return describe(code);
  return error instanceof Error ? error.message : String(error);
};

const isStale = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "SETTINGS_STALE";

/**
 * 备份收发的失败。中途断开对备份来说不是「可能计费、先别重试」：导出再点一次就行；
 * 导入可能已经写进去一部分，再导一次同一个文件不会重复。
 */
function backupFailureText(failure: Failure, kind: "export" | "import"): string {
  if (failure.code === "BACKGROUND_DROPPED" || failure.code === "BACKGROUND_UNREACHABLE") {
    return kind === "export"
      ? "导出失败：简幕的后台中途断开了，没导出来，再点一次「导出备份」。"
      : "恢复失败：简幕的后台中途断开了。可能已经导入了一部分，再选同一个文件导一次就行，已经导入的不会重复。";
  }
  return `${kind === "export" ? "导出失败" : "恢复失败"}：${failureText(failure)}`;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function createOptionsState(deps: OptionsDeps): OptionsState {
  const { store, api } = deps;
  const saved = signal<LoadedSettings | null>(null);
  const form = signal<AiForm | null>(null);
  const loadError = signal<string | null>(null);
  const aiStatus = signal<Status | null>(null);
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
      const check = validateForSave(settings);
      if (!check.ok) aiStatus.value = { text: check.errors.join(" "), tone: "error" };
    } catch (error) {
      loadError.value = `读不出设置：${errorText(error)}`;
    }
  }

  // 按存储重新载入过几次：保存在授权弹窗之后、排完队时比一下，期间重新载入过，点击时的表单就作废了。
  let reloads = 0;

  async function reloadStale(): Promise<void> {
    reloads += 1;
    models.value = [];
    await load();
    aiStatus.value = { text: STALE_TEXT, tone: "warn" };
  }

  // 本页自己的设置写入排成一条队：前一次（比如刚勾的同意）还没落地就点保存，保存要等它写完、拿它之后的修订号去核对。
  let ownQueue: Promise<unknown> = Promise.resolve();
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const run = ownQueue.then(work, work);
    ownQueue = run.catch(() => undefined);
    return run;
  }

  /** 自己写设置：写的途中自己引起的修订号变化不算别的页面改的。 */
  const ownWrite = (write: () => Promise<WrittenSettings>): Promise<WrittenSettings | null> => queued(async () => {
    ownWrites += 1;
    try {
      const written = await write();
      if (written.previousRevision !== revision) {
        await reloadStale();
        return null;
      }
      revision = written.settingsRevision;
      saved.value = written;
      return written;
    } finally {
      ownWrites -= 1;
    }
  });

  const onStorage: StorageListener = (changes, area) => {
    if (stopped || area !== "local" || ownWrites > 0) return;
    const change = (changes as Record<string, { newValue?: unknown } | undefined>)[SETTINGS_REVISION_KEY];
    if (change && (change.newValue ?? "") !== revision) void reloadStale();
  };
  deps.storageChanged?.addListener(onStorage);

  const setForm = (next: AiForm): void => {
    form.value = next;
  };

  // 连着改档位时回复可能乱序，只认最后一问。
  let effortAsk = 0;
  async function refreshEfforts(): Promise<void> {
    const current = form.peek();
    if (!current || stopped) return;
    const ask = ++effortAsk;
    const reply = await api.send("ai.effortPreview", { efforts: { ...current.featureEfforts } }).catch(() => null);
    if (ask !== effortAsk || stopped) return;
    efforts.value = reply?.ok && Array.isArray(reply.value.items) ? reply.value.items : null;
  }

  async function save(): Promise<boolean> {
    const current = form.peek();
    const before = saved.peek();
    if (!current || !before || busy.peek()) return false;
    // 按点击那一刻的表单保存。修订号用本页排在前面的写入落地之后的；授权弹窗期间别的页面清过密钥或全部数据，
    // 这次保存作废，不把清掉的写回去。
    const input = settingsInput(current, before);
    const check = validateForSave(input);
    const origin = check.ok ? originOf(check.settings.aiBaseUrl) : null;
    if (!check.ok || !origin) {
      aiStatus.value = { text: check.errors.join(" ") || "API 地址不合法。", tone: "error" };
      return false;
    }
    const asked = deps.requestHost(`${origin}*`);
    const reloadsAtClick = reloads;
    busy.value = "save";
    try {
      let granted = false;
      try {
        granted = await asked;
      } catch (error) {
        aiStatus.value = { text: `申请权限失败：${errorText(error)}`, tone: "error" };
        return false;
      }
      if (!granted) {
        aiStatus.value = { text: `没有拿到 ${origin} 的访问权限，AI 功能用不了。`, tone: "error" };
        return false;
      }
      const written = await queued(async () => {
        // 等授权、排队的工夫别的页面改过设置（比如清了密钥），表单已经按存储重新载入：点击时的表单不能再写回去。
        if (reloads !== reloadsAtClick) {
          aiStatus.value = { text: STALE_TEXT, tone: "warn" };
          return null;
        }
        ownWrites += 1;
        try {
          // 表单上没有的字段（同意、外观）用排在前面的写入落地之后的设置补全，不拿点击时的旧值盖回去。
          const result = await store.save(settingsInput(current, saved.peek() ?? before), revision);
          revision = result.settingsRevision;
          saved.value = result;
          return result;
        } catch (error) {
          if (isStale(error)) await reloadStale();
          else aiStatus.value = { text: `没有保存：${errorText(error)}`, tone: "error" };
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
      const ready = validate(written);
      aiStatus.value = ready.ok
        ? { text: written.rememberApiKey ? "已保存并授权，密钥已记在这台电脑上。" : "已保存并授权。", tone: "ok" }
        : { text: `已保存并授权，但 AI 功能暂时用不了：${ready.errors.join(" ")}`, tone: "warn" };
      return true;
    } finally {
      busy.value = null;
    }
  }

  async function saveInstant(patch: SettingsPatch): Promise<void> {
    try {
      await ownWrite(() => store.update(patch));
    } catch (error) {
      aiStatus.value = { text: `没有保存：${errorText(error)}`, tone: "error" };
    }
  }

  async function testOne(feature?: FeatureSlotId): Promise<string> {
    const reply = await api.send("ai.testConnection", feature ? { feature } : {});
    const label = feature ? FEATURE_MODEL_SLOTS.find(({ id }) => id === feature)?.label : "默认模型";
    if (!reply.ok) return `${label}：${failureText(reply)}`;
    const { model, reply: text, truncated } = reply.value;
    return `${label}（${model}）连接正常，回复「${text}」${truncated ? "（回复被截断）" : ""}`;
  }

  /** 拉模型和测试连接用后台存着的设置：先按点击时的表单保存，存成了再发。 */
  async function afterSave(kind: "models" | "test", work: () => Promise<void>): Promise<void> {
    if (!(await save())) return;
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
    },
    editFeatureModel(id, model) {
      const current = form.peek();
      if (current) setForm({ ...current, featureModels: { ...current.featureModels, [id]: model } });
    },
    editEffort(id, effort) {
      const current = form.peek();
      if (!current) return;
      setForm({ ...current, featureEfforts: { ...current.featureEfforts, [id]: effort } });
      void refreshEfforts();
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
        await ownWrite(() => store.setDataConsent(given));
      } catch (error) {
        aiStatus.value = { text: `没有保存：${errorText(error)}`, tone: "error" };
      }
    },
    async enableAuto() {
      try {
        const consented = await ownWrite(() => store.setDataConsent(true));
        if (!consented) return;
        const written = await ownWrite(() => store.update({ autoOverview: true }));
        autoStatus.value = written ? null : { text: STALE_TEXT, tone: "warn" };
      } catch (error) {
        autoStatus.value = { text: `没有打开：${errorText(error)}`, tone: "error" };
      }
    },
    async setRemember(remember) {
      const current = form.peek();
      if (!current) return;
      setForm({ ...current, rememberApiKey: remember });
      if (remember) {
        aiStatus.value = { text: "点「保存并授权」以后，密钥才会记在这台电脑上。", tone: "warn" };
        return;
      }
      try {
        const written = await ownWrite(() => store.update({ rememberApiKey: false }));
        if (written) aiStatus.value = { text: "已不再记住密钥：这台电脑上存的那份已删除，密钥只留在本次浏览器会话里。", tone: "ok" };
      } catch (error) {
        setForm({ ...current, rememberApiKey: true });
        aiStatus.value = { text: `没有关掉：${errorText(error)}`, tone: "error" };
      }
    },
    async clearKey() {
      try {
        const written = await ownWrite(() => store.update({ aiApiKey: "" }));
        if (!written) return;
        const current = form.peek();
        if (current) setForm({ ...current, aiApiKey: "", keyTyped: false, rememberApiKey: false });
        aiStatus.value = { text: "已删除保存的 API 密钥。", tone: "ok" };
      } catch (error) {
        aiStatus.value = { text: `删除失败：${errorText(error)}`, tone: "error" };
      }
    },
    fetchModels: () =>
      afterSave("models", async () => {
        const reply = await api.send("models.list", {});
        if (!reply.ok) {
          aiStatus.value = { text: `没拉到模型列表：${failureText(reply)}`, tone: "error" };
          return;
        }
        models.value = reply.value.ids;
        aiStatus.value = reply.value.ids.length
          ? { text: `拉到 ${reply.value.ids.length} 个模型，可以在模型框里直接选。`, tone: "ok" }
          : { text: "服务没有返回模型，请手动填写模型名称。", tone: "warn" };
      }),
    testConnection: (all) =>
      afterSave("test", async () => {
        const current = form.peek();
        const features = all && current ? chosenFeatures(current) : [];
        const lines = [await testOne()];
        for (const feature of features) lines.push(await testOne(feature));
        const failed = lines.some((line) => !line.includes("连接正常"));
        aiStatus.value = { text: lines.join("\n"), tone: failed ? "error" : "ok" };
      }),
    probeImage: FEATURE_FRAME_EXPLAIN
      ? () =>
          afterSave("test", async () => {
            aiStatus.value = await probeFrameImage(api, failureText);
          })
      : async () => undefined,
    async exportBackup() {
      if (busy.peek()) return;
      busy.value = "export";
      try {
        const reply = await receiveBackup(api);
        if (!reply.ok) {
          dataStatus.value = { text: backupFailureText(reply, "export"), tone: "error" };
          return;
        }
        const date = (deps.now ?? (() => new Date()))();
        const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        deps.download(`简幕备份-${stamp}.json`, backupText(reply.value));
        const { notes, overviews, qa, translations } = reply.value;
        dataStatus.value = { text: `已导出 ${notes.length} 条笔记、${overviews.length} 份概览、${qa.length} 条问答、${translations.length} 份译文和整理过的字幕。`, tone: "ok" };
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
          dataStatus.value = { text: "读不出这个文件：文件可能太大，或者已经被移走了。", tone: "error" };
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          dataStatus.value = { text: "读不懂这个文件，请选简幕导出的 JSON 备份。", tone: "error" };
          return;
        }
        const read = readBackup(payload);
        if (!read.ok) {
          dataStatus.value = { text: `恢复失败：${failureText(read)}`, tone: "error" };
          return;
        }
        const reply = await sendBackup(api, read.value);
        dataStatus.value = reply.ok ? { text: importSummary(reply.value), tone: "ok" } : { text: backupFailureText(reply, "import"), tone: "error" };
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
          dataStatus.value = { text: `清除失败：${failureText(reply)}`, tone: "error" };
          return;
        }
        if (scope === "all") {
          models.value = [];
          await load();
          aiStatus.value = null;
          dataStatus.value = { text: "已清除这台电脑上的全部数据，设置已恢复默认。", tone: "ok" };
          return;
        }
        dataStatus.value = { text: "已清除缓存。", tone: "ok" };
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
