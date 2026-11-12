// 设置页的状态和动作：设置直接经设置仓库读写（排在同一把锁里，密钥不落盘），拉模型、测试连接、备份和清除发给后台。
// 主机权限的申请要在用户点击的同一个调用栈里发起，所以保存先同步发起申请，再等别的。
import { signal, type ReadonlySignal } from "@preact/signals";
import type { ClearScope } from "../../core/clear-guard.ts";
import { describe, isErrorCode, type Failure } from "../../core/errors.ts";
import { AI_ERROR_TEXT } from "../../core/errors/ai.ts";
import type { LoadedSettings, SettingsPatch, SettingsStore, WrittenSettings } from "../../platform/settings-store.ts";
import type { BackupImportReply } from "../../shared/messages/data.ts";
import { SETTINGS_REVISION_KEY } from "../../shared/names.ts";
import { FEATURE_MODEL_SLOTS, originOf, validate, validateForSave, type FeatureSlotId } from "../../shared/settings-schema.ts";
import type { PageApi } from "../shared/api.ts";
import { chosenFeatures, formOf, settingsInput, withAddress, withPreset, type AiForm } from "./form.ts";

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
  readonly api: Pick<PageApi, "send">;
  /** 申请一条主机权限；必须在点击的同步调用栈里调用。 */
  readonly requestHost: (pattern: string) => Promise<boolean>;
  /** 把备份存成文件。 */
  readonly download: (filename: string, text: string) => void;
  readonly storageChanged?: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
  readonly now?: () => Date;
}

export interface OptionsState {
  readonly saved: ReadonlySignal<LoadedSettings | null>;
  readonly form: ReadonlySignal<AiForm | null>;
  readonly loadError: ReadonlySignal<string | null>;
  readonly aiStatus: ReadonlySignal<Status | null>;
  readonly dataStatus: ReadonlySignal<Status | null>;
  readonly busy: ReadonlySignal<Busy>;
  readonly models: ReadonlySignal<readonly string[]>;
  load(): Promise<void>;
  edit(patch: Partial<Pick<AiForm, "aiModel" | "analysisChunkMode" | "rememberApiKey">>): void;
  editKey(key: string): void;
  editFeatureModel(id: FeatureSlotId, model: string): void;
  choosePreset(presetId: string): void;
  editAddress(patch: Pick<AiForm, "aiBaseUrl"> | Pick<AiForm, "protocol">): void;
  save(): Promise<boolean>;
  saveInstant(patch: SettingsPatch): Promise<void>;
  setConsent(given: boolean): Promise<void>;
  setRemember(remember: boolean): Promise<void>;
  clearKey(): Promise<void>;
  fetchModels(): Promise<void>;
  testConnection(all: boolean): Promise<void>;
  exportBackup(): Promise<void>;
  importBackup(text: string): Promise<void>;
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

function importText({ counts, promptsDropped }: BackupImportReply): string {
  const { notes, overviews, qa } = counts;
  let text = `合并完成：笔记新增 ${notes.added} 条、更新 ${notes.updated} 条，概览新增 ${overviews.added} 份、更新 ${overviews.updated} 份，问答新增 ${qa.added} 条。`;
  const skipped = [notes.skipped ? `${notes.skipped} 条笔记` : "", overviews.skipped ? `${overviews.skipped} 份概览` : "", qa.skipped ? `${qa.skipped} 条问答` : ""].filter(Boolean);
  if (skipped.length) text += `备份里有 ${skipped.join("、")}格式不对，已跳过。`;
  if (promptsDropped) text += "备份里的自定义提示词没有导入：现在只用内置的提示词。";
  return text;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function createOptionsState(deps: OptionsDeps): OptionsState {
  const { store, api } = deps;
  const saved = signal<LoadedSettings | null>(null);
  const form = signal<AiForm | null>(null);
  const loadError = signal<string | null>(null);
  const aiStatus = signal<Status | null>(null);
  const dataStatus = signal<Status | null>(null);
  const busy = signal<Busy>(null);
  const models = signal<readonly string[]>([]);
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
      const check = validateForSave(settings);
      if (!check.ok) aiStatus.value = { text: check.errors.join(" "), tone: "error" };
    } catch (error) {
      loadError.value = `读不出设置：${errorText(error)}`;
    }
  }

  async function reloadStale(): Promise<void> {
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

  async function save(): Promise<boolean> {
    const current = form.peek();
    const before = saved.peek();
    if (!current || !before || busy.peek()) return false;
    // 按点击那一刻的表单保存。修订号用本页排在前面的写入落地之后的：授权弹窗期间别的页面清过密钥或全部数据，
    // 本页记着的修订号就对不上，这次保存作废，不把清掉的写回去。
    const input = settingsInput(current, before);
    const check = validateForSave(input);
    const origin = check.ok ? originOf(check.settings.aiBaseUrl) : null;
    if (!check.ok || !origin) {
      aiStatus.value = { text: check.errors.join(" ") || "API 地址不合法。", tone: "error" };
      return false;
    }
    const asked = deps.requestHost(`${origin}*`);
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
    }
  }

  return {
    saved,
    form,
    loadError,
    aiStatus,
    dataStatus,
    busy,
    models,
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
    async exportBackup() {
      if (busy.peek()) return;
      busy.value = "export";
      try {
        const reply = await api.send("backup.export", {});
        if (!reply.ok) {
          dataStatus.value = { text: `导出失败：${failureText(reply)}`, tone: "error" };
          return;
        }
        const date = (deps.now ?? (() => new Date()))();
        const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        deps.download(`简幕备份-${stamp}.json`, `${JSON.stringify(reply.value, null, 2)}\n`);
        const { notes, overviews, qa } = reply.value;
        dataStatus.value = { text: `已导出 ${notes.length} 条笔记、${overviews.length} 份概览、${qa.length} 条问答。`, tone: "ok" };
      } finally {
        busy.value = null;
      }
    },
    async importBackup(text) {
      if (busy.peek()) return;
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        dataStatus.value = { text: "读不懂这个文件，请选简幕导出的 JSON 备份。", tone: "error" };
        return;
      }
      busy.value = "import";
      try {
        const reply = await api.send("backup.import", { payload });
        dataStatus.value = reply.ok ? { text: importText(reply.value), tone: "ok" } : { text: `恢复失败：${failureText(reply)}`, tone: "error" };
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
