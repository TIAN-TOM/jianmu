// 设置页「资料」一节：导出、导入备份，清除本机数据。
// 导出只读本机的四个仓储（笔记、概览、问答、译文和整理后的字幕），不发平台和模型请求，确认启用之前也能用；
// 导入分段进来（单条消息有大小上限），每段在对应仓储的写入队列里读本机的再合并，清除闸门的代数从连上那一刻算起；
// 清除先停下在跑的任务，再在清除闸门里删仓库和存储键，删完广播给各页面。
import { buildBackup, type Backup } from "../../core/backup/format.ts";
import { mergeNotes, mergeOverviews, mergeQa, mergeTranslations, type MergeResult } from "../../core/backup/merge.ts";
import { checkNote, checkOverview, checkQa, checkTranslation, keepValid, type RecordKind } from "../../core/backup/records.ts";
import type { ClearGuard, ClearScope } from "../../core/clear-guard.ts";
import { fail, ok, type Result } from "../../core/errors.ts";
import type { ExtensionStorage } from "../../platform/storage.ts";
import type { SettingsStore } from "../../platform/settings-store.ts";
import type { Broadcast } from "../../shared/messages.ts";
import type { StoreName } from "../../shared/names.ts";
import { clearTargets } from "../../shared/storage-plan.ts";
import type { NoteStore } from "../stores/notes.ts";
import type { OverviewStore } from "../stores/overviews.ts";
import type { QaStore } from "../stores/qa.ts";
import type { TranslationStore } from "../stores/translations.ts";
import type { TaskRunner } from "../tasks.ts";

export interface DataServiceDeps {
  readonly notes: Pick<NoteStore, "all" | "update">;
  readonly overviews: Pick<OverviewStore, "all" | "update">;
  readonly qa: Pick<QaStore, "all" | "commit">;
  readonly translations: Pick<TranslationStore, "all" | "update">;
  readonly guard: ClearGuard;
  readonly tasks: Pick<TaskRunner, "cancelAll">;
  readonly settings: Pick<SettingsStore, "clearAll">;
  readonly storage: ExtensionStorage;
  /** 忘掉取字幕服务内存里记着的字幕、官方总结和轻量读取，在途读取不再给之后的调用合并。 */
  readonly forgetMemory: (scope: ClearScope) => void;
  /** 清空一个数据库仓库。 */
  readonly clearStore: (name: StoreName) => Promise<void>;
  readonly broadcast: (message: Broadcast) => void;
  readonly now: () => number;
}

/** 合并完的一段：新增和更新的主键，核对时跳过的条数。 */
export interface MergedPart {
  readonly added: string[];
  readonly updated: string[];
  readonly skipped: number;
}

/** 一次导入：各段按顺序交进来；结束时（不管是不是导完）有改动就广播一次。 */
export interface ImportSession {
  readonly merge: (kind: RecordKind, records: readonly unknown[]) => Promise<Result<MergedPart>>;
  readonly close: () => void;
}

export interface DataService {
  readonly exportBackup: () => Promise<Backup>;
  readonly openImport: () => ImportSession;
  readonly clear: (scope: ClearScope) => Promise<void>;
}

/** 清除时停下任务的原因。 */
const CLEARING = Object.freeze({ code: "LOCAL_DATA_CLEARED" });

const mergedPart = <T>(merged: MergeResult<T>, skipped: number): MergedPart => ({
  added: merged.addedKeys,
  updated: merged.updatedKeys,
  skipped,
});

export function createDataService(deps: DataServiceDeps): DataService {
  const { notes, overviews, qa, guard } = deps;

  function openImport(): ImportSession {
    const since = guard.epoch();
    let changed = false;

    // 记录在页面已经核对过，这里再过一遍：后台只认自己核对过的记录。
    async function mergeKind(kind: RecordKind, records: readonly unknown[]): Promise<MergedPart | null> {
      switch (kind) {
        case "notes": {
          const valid = keepValid(records, checkNote);
          return notes.update((current) => {
            const merged = mergeNotes(current, valid.kept);
            return { put: merged.changed, result: mergedPart(merged, valid.skipped) };
          }, { since });
        }
        case "overviews": {
          const valid = keepValid(records, checkOverview);
          return overviews.update((current) => {
            const merged = mergeOverviews(current, valid.kept);
            return { put: merged.changed, result: mergedPart(merged, valid.skipped) };
          }, { since });
        }
        case "qa": {
          // 问答记下以后不改，只补本机没有的；两次读写之间别处新增的问答 id 不会和备份里的撞上。
          const valid = keepValid(records, checkQa);
          const merged = mergeQa(await qa.all(), valid.kept);
          return (await qa.commit({ put: merged.changed }, { since })) ? mergedPart(merged, valid.skipped) : null;
        }
        case "translations": {
          const valid = keepValid(records, checkTranslation);
          return deps.translations.update((current) => {
            const merged = mergeTranslations(current, valid.kept, deps.now());
            return { put: merged.changed, result: mergedPart(merged, valid.skipped) };
          }, { since });
        }
      }
    }

    return {
      async merge(kind, records) {
        const part = await mergeKind(kind, records);
        if (part === null) return fail("LOCAL_DATA_CLEARED");
        if (part.added.length || part.updated.length) changed = true;
        return ok(part);
      },
      close() {
        if (!changed) return;
        changed = false;
        deps.broadcast({ type: "notes.changed" });
      },
    };
  }

  async function clear(scope: ClearScope): Promise<void> {
    // 在跑的生成先停下：它们回来写的那一下也会被闸门拦住，停下是为了不再花钱。
    deps.tasks.cancelAll(CLEARING);
    const targets = clearTargets(scope);
    await guard.clear(scope, async () => {
      deps.forgetMemory(scope);
      await Promise.all(targets.stores.map((name) => deps.clearStore(name)));
      if (scope === "all") {
        await deps.settings.clearAll();
        return;
      }
      await deps.storage.local.remove([...targets.local]);
      await deps.storage.session.remove([...targets.session]);
    });
    deps.broadcast({ type: "data.cleared", scope });
  }

  return {
    exportBackup: async () => {
      const [noteList, overviewList, qaList, translationList] = await Promise.all([notes.all(), overviews.all(), qa.all(), deps.translations.all()]);
      return buildBackup({ notes: noteList, overviews: overviewList, qa: qaList, translations: translationList }, deps.now());
    },
    openImport,
    clear,
  };
}
