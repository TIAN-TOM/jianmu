// 笔记仓储：按创建时间倒序读。读出来的行不信：形状不对的滤掉，不认识的字段不往外带，
// 链接只从身份现拼，库里存着什么链接都不交出去。
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { NoteRecord } from "../../core/notes/records.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export interface NoteView extends NoteRecord {
  readonly url: string;
}

export interface NoteChange<R = unknown> {
  readonly put?: readonly NoteRecord[];
  readonly remove?: readonly string[];
  readonly result?: R;
}

export interface NoteStoreDeps {
  readonly driver: ObjectStoreDriver<NoteRecord>;
  readonly guard: ClearGuard;
  // 站点适配层给的规范链接。
  readonly canonicalUrl: (ref: VideoRef, atSec?: number) => string;
}

export interface NoteStore {
  /** 全部笔记，最新的在前。 */
  readonly all: () => Promise<NoteView[]>;
  /** 一个视频的笔记，最新的在前。 */
  readonly byVideo: (video: VideoKey) => Promise<NoteView[]>;
  /** 写入一批，坏记录逐条跳过。清除过就不写，返回 false。 */
  readonly commit: (change: NoteChange, options?: WriteOptions) => Promise<boolean>;
  /**
   * 读—改—写一次做完：plan 拿到现读的全部笔记，返回要写的改动和结果。清除过就不调用 plan，返回 null。
   * plan 里不要再调这个仓储的写方法，它们排在这次后面，会一直等下去。
   */
  readonly update: <R>(
    plan: (current: NoteRecord[]) => NoteChange<R> | Promise<NoteChange<R>>,
    options?: WriteOptions,
  ) => Promise<R | null>;
}

function isValidNote(note: NoteRecord): boolean {
  return (
    typeof note.id === "string" &&
    note.id.trim() !== "" &&
    typeof note.video === "string" &&
    parseVideoKey(note.video) !== null &&
    Number.isFinite(note.atSec) &&
    note.atSec >= 0 &&
    typeof note.text === "string" &&
    Number.isFinite(note.createdAt)
  );
}

// 只留记录类型里有的字段，读写都过这一道，库里多出来的链接字段既出不去也写不回。
function cleanNote(note: NoteRecord): NoteRecord {
  const { id, kind, origin, video, snapshot, atSec, text, quote, derived, createdAt, updatedAt } = note;
  return {
    id,
    kind,
    origin,
    video,
    snapshot,
    atSec,
    text,
    ...(quote === undefined ? {} : { quote }),
    ...(derived === undefined ? {} : { derived }),
    createdAt,
    updatedAt,
  };
}

const readable = (rows: readonly NoteRecord[]): NoteRecord[] => rows.filter(isValidNote).map(cleanNote);

export function createNoteStore({ driver, guard, canonicalUrl }: NoteStoreDeps): NoteStore {
  const gate = createWriteGate(guard, "all");

  const withUrl = (note: NoteRecord): NoteView => ({
    ...note,
    url: canonicalUrl(parseVideoKey(note.video) as VideoRef, note.atSec),
  });

  const readAll = async (): Promise<NoteRecord[]> => readable(await driver.getAllByIndex("byCreated")).reverse();

  const applyChange = ({ put = [], remove = [] }: NoteChange): Promise<void> =>
    driver.write({ put: readable(put), remove });

  return {
    async all() {
      return (await readAll()).map(withUrl);
    },

    async byVideo(video) {
      const rows = readable(await driver.getAllByIndex("byVideo", video));
      return rows.sort((left, right) => right.createdAt - left.createdAt).map(withUrl);
    },

    async commit(change, { since } = {}) {
      const written = await gate(since, async () => {
        await applyChange(change);
        return true;
      });
      return written === true;
    },

    update(plan, { since } = {}) {
      return gate(since, async () => {
        const change = await plan(await readAll());
        await applyChange(change);
        return change.result ?? null;
      });
    },
  };
}
