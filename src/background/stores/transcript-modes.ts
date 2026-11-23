// 每个视频上次手动选择的字幕显示方式，最近选择的排在最前。
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { fail, ok, type Result } from "../../core/errors.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import { readItem, type StorageArea } from "../../platform/storage.ts";
import { isTranscriptMode, type TranscriptMode } from "../../shared/messages/transcript.ts";
import { TRANSCRIPT_MODES_KEY } from "../../shared/names.ts";
import { createWriteGate } from "./write-gate.ts";

interface Choice {
  readonly video: VideoKey;
  readonly mode: TranscriptMode;
}

export interface TranscriptModes {
  readonly displayMode: (video: VideoKey, mode: TranscriptMode | undefined, since: ClearEpoch | undefined) => Promise<Result<{ readonly mode: TranscriptMode }>>;
}

const MAX_VIDEOS = 50;

function choicesOf(value: unknown): Choice[] {
  if (!Array.isArray(value)) return [];
  const choices: Choice[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry.video !== "string" || !parseVideoKey(entry.video) || !isTranscriptMode(entry.mode) || seen.has(entry.video)) continue;
    choices.push({ video: entry.video as VideoKey, mode: entry.mode });
    seen.add(entry.video);
    if (choices.length === MAX_VIDEOS) break;
  }
  return choices;
}

export function createTranscriptModes({ storage, guard }: { storage: StorageArea; guard: ClearGuard }): TranscriptModes {
  const gate = createWriteGate(guard, "all");
  return {
    async displayMode(video, mode, since) {
      const selected = await gate(since, async () => {
        const choices = choicesOf(await readItem(storage, TRANSCRIPT_MODES_KEY));
        if (mode === undefined) return choices.find((entry) => entry.video === video)?.mode ?? "original";
        const recent = choices.filter((entry) => entry.video !== video).slice(0, MAX_VIDEOS - 1);
        await storage.set({ [TRANSCRIPT_MODES_KEY]: [{ video, mode }, ...recent] });
        return mode;
      });
      return selected === null ? fail("LOCAL_DATA_CLEARED") : ok({ mode: selected });
    },
  };
}
