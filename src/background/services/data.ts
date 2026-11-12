// 设置页「资料」一节：导出、导入备份，清除本机数据。
// 导出只读本机的三个仓储，不发平台和模型请求，确认启用之前也能用；导入按记录合并，读和写在各仓储的写入队列里一次做完；
// 清除先停下在跑的任务，再在清除闸门里删仓库和存储键，删完广播给各页面。
import { buildBackup, readBackup, type Backup } from "../../core/backup/format.ts";
import { mergeNotes, mergeOverviews, mergeQa } from "../../core/backup/merge.ts";
import type { ClearGuard, ClearScope } from "../../core/clear-guard.ts";
import { fail, ok, type Result } from "../../core/errors.ts";
import type { ExtensionStorage } from "../../platform/storage.ts";
import type { SettingsStore } from "../../platform/settings-store.ts";
import type { Broadcast } from "../../shared/messages.ts";
import type { BackupImportReply, ImportCount } from "../../shared/messages/data.ts";
import type { StoreName } from "../../shared/names.ts";
import { clearTargets } from "../../shared/storage-plan.ts";
import type { NoteStore } from "../stores/notes.ts";
import type { OverviewStore } from "../stores/overviews.ts";
import type { QaStore } from "../stores/qa.ts";
import type { TaskRunner } from "../tasks.ts";

export interface DataServiceDeps {
  readonly notes: Pick<NoteStore, "all" | "update">;
  readonly overviews: Pick<OverviewStore, "all" | "update">;
  readonly qa: Pick<QaStore, "all" | "commit">;
  readonly guard: ClearGuard;
  readonly tasks: Pick<TaskRunner, "cancelAll">;
  readonly settings: Pick<SettingsStore, "clearAll">;
  readonly storage: ExtensionStorage;
  /** 清空一个数据库仓库。 */
  readonly clearStore: (name: StoreName) => Promise<void>;
  readonly broadcast: (message: Broadcast) => void;
  readonly now: () => number;
}

export interface DataService {
  readonly exportBackup: () => Promise<Backup>;
  readonly importBackup: (payload: unknown) => Promise<Result<BackupImportReply>>;
  readonly clear: (scope: ClearScope) => Promise<void>;
}

/** 清除时停下任务的原因。 */
const CLEARING = Object.freeze({ code: "LOCAL_DATA_CLEARED" });

const counted = (merged: { readonly added: number; readonly updated: number }, skipped: number): ImportCount => ({
  added: merged.added,
  updated: merged.updated,
  skipped,
});

export function createDataService(deps: DataServiceDeps): DataService {
  const { notes, overviews, qa, guard } = deps;

  async function importBackup(payload: unknown): Promise<Result<BackupImportReply>> {
    const read = readBackup(payload);
    if (!read.ok) return read;
    const since = guard.epoch();
    const { contents, skipped } = read.value;
    // 各仓储在自己的写入队列里读本机现有的再合并，排队期间别处写进来的也算在内。
    const noteCount = await notes.update(
      (current) => {
        const merged = mergeNotes(current, contents.notes);
        return { put: merged.changed, result: counted(merged, skipped.notes) };
      },
      { since },
    );
    const overviewCount = await overviews.update(
      (current) => {
        const merged = mergeOverviews(current, contents.overviews);
        return { put: merged.changed, result: counted(merged, skipped.overviews) };
      },
      { since },
    );
    // 问答记下以后不改，只补本机没有的；两次读写之间别处新增的问答 id 不会和备份里的撞上。
    const mergedQa = mergeQa(await qa.all(), contents.qa);
    const qaSaved = await qa.commit({ put: mergedQa.changed }, { since });
    if (noteCount === null || overviewCount === null || !qaSaved) return fail("LOCAL_DATA_CLEARED");
    deps.broadcast({ type: "notes.changed" });
    return ok({
      counts: { notes: noteCount, overviews: overviewCount, qa: counted(mergedQa, skipped.qa) },
      promptsDropped: read.value.promptsDropped,
    });
  }

  async function clear(scope: ClearScope): Promise<void> {
    // 在跑的生成先停下：它们回来写的那一下也会被闸门拦住，停下是为了不再花钱。
    deps.tasks.cancelAll(CLEARING);
    const targets = clearTargets(scope);
    await guard.clear(scope, async () => {
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
      const [noteList, overviewList, qaList] = await Promise.all([notes.all(), overviews.all(), qa.all()]);
      return buildBackup({ notes: noteList, overviews: overviewList, qa: qaList }, deps.now());
    },
    importBackup,
    clear,
  };
}
