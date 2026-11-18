// 备份经长连接分段传：扩展的单条消息有大小上限，整份备份大了一次传不过去。
// 导出：后台先报每类多少条，再一段段发记录，这里拼回整份。导入：这里先认格式、读出记录，
// 再一段段发给后台合并，每段等后台回了才发下一段；计数按主键去重，和整份一次合并算出来的一样。
import { BACKUP_KIND, BACKUP_VERSION, type Backup } from "../../core/backup/format.ts";
import { joinParts, splitBackup, type BackupPart } from "../../core/backup/parts.ts";
import { RECORD_KINDS, type ImportedBackup, type RecordKind } from "../../core/backup/records.ts";
import { fail, ok, type ErrorCode, type Result } from "../../core/errors.ts";
import type { PortEvent, PortName } from "../../shared/messages.ts";
import type { BackupImportReply, ImportCount } from "../../shared/messages/data.ts";
import type { PageApi, PagePort } from "../shared/api.ts";

type Closed = { readonly type: "closed"; readonly code: ErrorCode };

interface Channel<P extends PortName> {
  readonly port: PagePort<P>;
  /** 下一条后台发来的消息；断开了就是 closed。 */
  readonly next: () => Promise<PortEvent<P> | Closed>;
}

function open<P extends PortName>(api: Pick<PageApi, "connect">, name: P): Channel<P> {
  const events: (PortEvent<P> | Closed)[] = [];
  let waiting: ((event: PortEvent<P> | Closed) => void) | null = null;
  const deliver = (event: PortEvent<P> | Closed): void => {
    const resolve = waiting;
    waiting = null;
    if (resolve) resolve(event);
    else events.push(event);
  };
  const port = api.connect(name, { onEvent: deliver, onClose: (code) => deliver({ type: "closed", code }) });
  return {
    port,
    next: () => {
      const event = events.shift();
      return event ? Promise.resolve(event) : new Promise((resolve) => void (waiting = resolve));
    },
  };
}

/** 后台说了原因的用那个码，没说就断了的算中途断开。 */
function stopped(event: { readonly type: string; readonly code?: ErrorCode }): ErrorCode {
  return (event.type === "port.error" || event.type === "closed") && event.code ? event.code : "BACKGROUND_DROPPED";
}

/** 从后台取一份完整的备份：条数和开头报的对不上就算没传完。 */
export async function receiveBackup(api: Pick<PageApi, "connect">): Promise<Result<Backup>> {
  const { port, next } = open(api, "backup.export");
  try {
    if (!port.post({ type: "start" })) return fail(stopped(await next()));
    const first = await next();
    if (first.type !== "head") return fail(stopped(first));
    const parts: BackupPart[] = [];
    for (;;) {
      const event = await next();
      if (event.type === "part") {
        parts.push(event.part);
        continue;
      }
      if (event.type !== "end") return fail(stopped(event));
      const contents = joinParts(parts);
      if (RECORD_KINDS.some((kind) => contents[kind].length !== first.counts[kind])) return fail("BACKGROUND_DROPPED");
      return ok({ kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAt: first.exportedAt, ...contents });
    }
  } finally {
    port.close();
  }
}

interface Tally {
  readonly added: Set<string>;
  readonly updated: Set<string>;
  skipped: number;
}

/** 把读好的备份一段段交给后台合并。计数：本次导入里先新增后又补过的仍算新增。 */
export async function sendBackup(api: Pick<PageApi, "connect">, imported: ImportedBackup): Promise<Result<BackupImportReply>> {
  const tallies = Object.fromEntries(
    RECORD_KINDS.map((kind) => [kind, { added: new Set<string>(), updated: new Set<string>(), skipped: imported.skipped[kind] }]),
  ) as Record<RecordKind, Tally>;
  const parts = splitBackup(imported.contents);
  if (parts.length) {
    const { port, next } = open(api, "backup.import");
    try {
      for (const [seq, part] of parts.entries()) {
        if (!port.post({ type: "part", seq, kind: part.kind, records: part.records })) return fail(stopped(await next()));
        const event = await next();
        if (event.type !== "merged" || event.seq !== seq) return fail(stopped(event));
        const tally = tallies[part.kind];
        for (const key of event.added) tally.added.add(key);
        for (const key of event.updated) tally.updated.add(key);
        tally.skipped += event.skipped;
      }
    } finally {
      port.close();
    }
  }
  const counts = Object.fromEntries(
    RECORD_KINDS.map((kind) => {
      const { added, updated, skipped } = tallies[kind];
      const count: ImportCount = { added: added.size, updated: [...updated].filter((key) => !added.has(key)).length, skipped };
      return [kind, count];
    }),
  ) as Record<RecordKind, ImportCount>;
  return ok({ counts, promptsDropped: imported.promptsDropped });
}
