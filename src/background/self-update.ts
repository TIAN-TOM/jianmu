// 文件换了就自己重新加载：解压覆盖新版以后，浏览器不会自己发现扩展目录里的文件变了，后台还跑着旧代码，
// 新打开的页面和旧后台对不上。后台醒来时看一眼包里的构建标识文件（读到的是磁盘上现在的内容），和自己编进去的不一样就重新加载。
// 只读本机自己的文件，不联网；不常驻轮询，一分钟最多看一次；有花额度的工作在跑就等它做完再重载；
// 同一个新标识重载过几次还是对不上（文件没换全、坏了），先停下，不来回重载。
import { readItem, type ExtensionStorage } from "../platform/storage.ts";
import { BUILD_ID, BUILD_ID_FILE } from "../shared/build-id.ts";
import { SELF_RELOAD_KEY } from "../shared/names.ts";
import { errorLabel, type Log } from "./log.ts";

/** 两次看文件至少隔这么久。 */
export const CHECK_INTERVAL_MS = 60_000;
/** 等工作做完时，隔这么久再看一次还忙不忙。 */
export const BUSY_RECHECK_MS = 15_000;
/** 同一个新标识最多连着重载这么多次，这段时间里还对不上就不再试。 */
export const RELOAD_ATTEMPTS = 3;
export const RELOAD_WINDOW_MS = 10 * 60_000;

/** 上一次因为文件换了而重载的记录，存在本机，重载以后还在。 */
export interface ReloadRecord {
  readonly target: string;
  readonly count: number;
  readonly since: number;
}

export interface SelfUpdateDeps {
  /** 这次构建编进去的标识。 */
  readonly buildId: string;
  /** 读包里的构建标识文件；读不到回 null。 */
  readonly readBuildId: () => Promise<string | null>;
  /** 有没有花额度的工作在跑：任务、批次、润色。 */
  readonly busy: () => boolean;
  readonly reload: () => void;
  readonly loadRecord: () => Promise<ReloadRecord | null>;
  readonly saveRecord: (record: ReloadRecord) => Promise<void>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly log: Pick<Log, "warn">;
}

export interface SelfUpdate {
  /** 后台每个事件都调一次；节流在里面做。 */
  readonly check: () => Promise<void>;
}

const isRecord = (value: unknown): value is ReloadRecord => {
  const record = value as Partial<ReloadRecord> | null;
  return typeof record === "object" && record !== null && typeof record.target === "string" && Number.isFinite(record.count) && Number.isFinite(record.since);
};

export function createSelfUpdate(deps: SelfUpdateDeps): SelfUpdate {
  let lastCheck = Number.NEGATIVE_INFINITY;
  let waiting = false;
  let done = false;

  async function changed(): Promise<string | null> {
    try {
      const disk = (await deps.readBuildId())?.trim();
      return disk && disk !== deps.buildId ? disk : null;
    } catch (error) {
      deps.log.warn("读不出包里的构建标识，这次不看文件换没换", errorLabel(error));
      return null;
    }
  }

  async function reloadFor(target: string): Promise<void> {
    const now = deps.now();
    const last = await deps.loadRecord().catch(() => null);
    const fresh = !last || last.target !== target || now - last.since > RELOAD_WINDOW_MS;
    const record: ReloadRecord = fresh ? { target, count: 1, since: now } : { ...last, count: last.count + 1 };
    if (record.count > RELOAD_ATTEMPTS) {
      done = true;
      deps.log.warn("重新加载了几次，包里的文件还是对不上，先不再重载；文件换全以后到扩展管理页手动刷新");
      return;
    }
    await deps.saveRecord(record);
    done = true;
    deps.reload();
  }

  async function settle(): Promise<void> {
    const target = await changed();
    if (!target || done) return;
    if (deps.busy()) {
      // 有工作在跑：隔一会儿再看，做完了再重载。等的时候后台本来就醒着。
      if (waiting) return;
      waiting = true;
      deps.setTimeout(() => {
        waiting = false;
        void settle();
      }, BUSY_RECHECK_MS);
      return;
    }
    await reloadFor(target);
  }

  return {
    async check() {
      if (done || waiting) return;
      const now = deps.now();
      if (now - lastCheck < CHECK_INTERVAL_MS) return;
      lastCheck = now;
      await settle();
    },
  };
}

export interface SelfUpdateWiring {
  readonly readOwnFile?: (path: string) => Promise<string | null>;
  readonly runtime: { reload?(): void };
  readonly storage: Pick<ExtensionStorage, "local">;
  readonly timers: Pick<SelfUpdateDeps, "now" | "setTimeout">;
  readonly log: Pick<Log, "warn">;
  readonly busy: () => boolean;
}

/** 读得到自己的文件、能重新加载时才装上；测试的后台替身两样都没给，就不看。 */
export function wireSelfUpdate({ readOwnFile, runtime, storage, timers, log, busy }: SelfUpdateWiring): SelfUpdate | null {
  if (!readOwnFile || !runtime.reload) return null;
  return createSelfUpdate({
    buildId: BUILD_ID,
    readBuildId: () => readOwnFile(BUILD_ID_FILE),
    busy,
    reload: () => runtime.reload?.(),
    loadRecord: async () => {
      const value = await readItem(storage.local, SELF_RELOAD_KEY);
      return isRecord(value) ? value : null;
    },
    saveRecord: (record) => storage.local.set({ [SELF_RELOAD_KEY]: record }),
    now: timers.now,
    setTimeout: timers.setTimeout,
    log,
  });
}
