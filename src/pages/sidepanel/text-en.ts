// 侧边栏的界面文案，英文这份。形状由简体那份（text-zh.ts）定，少一条、多一条或者函数签名不一样，类型检查就报错。
// 构建开关保护的功能的文案不放这里，见 text-zh.ts 开头。模块顶层只放字面量和函数。
import type { PanelText } from "./text-zh.ts";

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const PANEL_EN: PanelText = {
  title: "Jianmu",
  loading: "Loading…",
  retry: "Try again",
  stop: "Stop",
  cancel: "Cancel",
  inUse: "In use",
  openSettings: "Open settings",
  notFound: (query) => `No results for “${query}”`,
  optionsFailed: "Couldn't open settings. You can open Jianmu's options from the extensions page.",
  remembered: (author, study) => `Remembered: videos from ${author || "this channel"} will open in ${study ? "Study" : "Skim"} from now on`,

  head: {
    loadingVideo: "Loading video",
    switchTrack: "Change subtitle language",
    imported: (fileName) => `Imported: ${fileName}`,
    notes: "Notes",
  },

  noVideo: {
    title: "Open a Bilibili video",
    impact: "Open the side panel on a Bilibili video page to read subtitles, generate an overview, ask questions and take notes.",
  },

  dock: {
    ask: "Ask about this video",
    history: "Q&A history",
    saveNote: "Save note",
    noPosition: "Jianmu doesn't know where the video is up to yet. Try again once the video page connects.",
  },

  notices: {
    connect: "The video page isn't connected to Jianmu yet. Refresh it to jump around and follow playback.",
    reloadPage: "Refresh video page",
    switchedToStudy: "Switched to Study",
    backToSkim: "Back to Skim",
    autoPaused: {
      quota: "Your API credit ran out, so Verdict on open is paused. It resumes after one successful manual overview, or after you turn it off and on again in settings.",
      key: "Your API key was rejected, so Verdict on open is paused. It resumes after one successful manual overview, or after you turn it off and on again in settings.",
      "local-origin": "The service on this computer refused requests from the browser extension. This usually isn't a key problem. Verdict on open is paused. Once it's fixed, it resumes after one successful manual overview, or after you turn it off and on again in settings.",
    },
  },

  player: {
    VIDEO_CHANGED: "The video on the page has changed. Refresh the side panel or go back to the original video and try again.",
    AD_PLAYING: "An ad is playing. Wait for it to finish, then try again.",
    NO_VIDEO: "Couldn't find a video on the page.",
    UNREACHABLE: "The video page isn't connected to Jianmu yet. Refresh it to jump around.",
  },

  batch: {
    label: "Generate all in this window",
    counting: "Counting the videos in this window…",
    notice: (concurrency) =>
      `Once you confirm, Jianmu reads each video's subtitles and sends them to your model service to write an overview. This uses your API credit, with up to ${concurrency} requests at a time. It keeps going if you close the side panel.`,
    start: (count) => `Generate ${count}`,
    gotIt: "Got it",
    progressLabel: "Progress in this window",
    stopping: "Stopping…",
    stopAll: "Stop all",
    collapse: "Hide",
    canceled: "Stopped",
    failed: "Couldn't generate",
    partialLabel: "Incomplete overviews",
    partialReason: "Some parts didn't generate. Open this video and click “Redo failed parts”.",
    stopped: (reason) => `This batch stopped. ${reason}`,
    empty: "There are no videos open in this window.",
    head: (total, existing, running, todo) => {
      const head = `This window has ${plural(total, "video", "videos")}.`;
      const skipped = [existing ? `${existing} with an overview already` : "", running ? `${running} being generated` : ""].filter(Boolean);
      if (!todo) return `${head} ${skipped.join(" and ")}, so there's nothing new to generate.`;
      const fresh = `${plural(todo, "overview", "overviews")} to generate.`;
      if (!skipped.length) return `${head} ${fresh}`;
      if (skipped.length === 1) return `${head} Skipping ${skipped[0]}. ${fresh}`;
      return `${head} Skipping ${existing + running} (${skipped.join(", ")}). ${fresh}`;
    },
    openEach: (count, head) => {
      const videos = plural(count, "YouTube video", "YouTube videos");
      const tail = "to open one at a time. Click “Read subtitles” on each video page.";
      return head ? `${head} ${count === 1 ? "There's also" : "There are also"} ${videos} ${tail}` : `This window has ${videos} ${tail}`;
    },
    progress: (counts) => {
      const parts = [`This window: ${counts.completed} of ${counts.total} done`];
      if (counts.partial) parts.push(`${counts.partial} incomplete`);
      if (counts.failed) parts.push(`${counts.failed} failed`);
      if (counts.canceled) parts.push(`${counts.canceled} stopped`);
      if (counts.skipped) parts.push(`${counts.skipped} skipped`);
      return parts.join(", ");
    },
    withStop: (progress, stop) => `${progress}. ${stop}`,
    stop: {
      "rate-limited": "Bilibili is limiting requests, so the rest weren't read. Try them one at a time in a few minutes.",
      "need-login": "Bilibili asked you to sign in, so the rest weren't read. Sign in, then try them one at a time.",
      source: "Bilibili sent back something Jianmu couldn't read, so the rest weren't read. Try them one at a time later.",
    },
  },

  guides: {
    official: "Official summary",
    creator: "Creator's chapters",
    queued: "The video site doesn't have an official summary for this video yet.",
    needLogin: "Sign in to the video site to see its official summary.",
    failed: "Couldn't get the official summary this time. Jianmu will ask again shortly.",
    pending: "Getting the official summary…",
  },

  skim: {
    saveAsNote: "Save as note",
    savedNote: "Saved",
    chapterCues: "Subtitles for this part",
    quotes: "Key quotes",
    writingVerdict: "Writing the one-line verdict…",
    verdictFromOfficial: "Write a verdict from the official summary",
    verdictFromOfficialNote: "Sends one small request without reading the subtitles",
    nothingToExport: "There's nothing to export yet",
    generating: (done, total) => `Generating overview, part ${done} of ${total}`,
    generatingPlain: "Generating overview…",
    stopGenerating: "Stop generating",
    failedChunks: (count) => `${plural(count, "part", "parts")} didn't generate. You can redo just ${count === 1 ? "that one" : "those"}.`,
    saveFailed: "The overview was generated but couldn't be saved on this computer.",
    canceled: (count) => `Stopped partway. ${count === 1 ? "The finished part was" : `The ${count} finished parts were`} saved.`,
    overviewLabel: "Overview written by the model",
    retryFailed: "Redo failed parts",
    regenerate: "Regenerate",
    needTranscript: "Subtitles need to load first",
    generate: "Generate overview",
    exportStudy: "Export study notes",
    transcriptLabel: "Subtitles",
  },

  study: {
    currentChapter: "Current chapter",
    jumpToChapter: (time) => `Jump to the start of this chapter at ${time}`,
  },

  notes: {
    saved: "Saved as a note",
    duplicate: "There's already a note at this time",
    deleted: "Note deleted",
    scopes: { video: "This video", all: "All" },
    scopeLabel: "Which notes",
    polishing: "Tidying up",
    actions: "Note actions",
    edit: "Edit",
    delete: "Delete",
    deleteHint: "This can't be undone",
    content: "Note text",
    save: "Save",
    nothingToExport: "There are no notes to export",
    allNotes: "All notes",
    count: (count) => plural(count, "note", "notes"),
    exportMarkdown: "Export Markdown",
    searchPlaceholder: "Search notes, titles or creators",
    searchLabel: "Search notes",
    emptyTitle: "No notes yet",
    emptyImpact: "Save key quotes from the overview as notes, or click the notes icon on the player or press n.",
  },

  qa: {
    title: "Q&A",
    delete: "Delete this Q&A",
    truncated: "The answer was cut off and may be incomplete.",
    unsaved: "This answer couldn't be saved to your Q&A history.",
    citations: "Quoted subtitles",
    placeholder: "Ask about this video, then press Enter",
    ask: "Ask",
    hint: "Each question is answered on its own, so write follow-up questions out in full.",
    answering: "Searching the subtitles and answering…",
    emptyTitle: "No Q&A yet",
    failed: "Couldn't answer this question.",
    pending: "Answering a question",
  },

  transcript: {
    modes: { original: "Original", translated: "Translation", bilingual: "Both" },
    explain: "Explain",
    explainTitle: (selection) => `Explain: ${selection}`,
    explaining: "Asking the model to explain…",
    translateHint: "Asks the model to translate any segments not yet translated, using your API credit. It keeps going if you close the side panel",
    file: "Subtitles",
    copied: "Copied all subtitles",
    copyFailed: "Couldn't copy. The browser blocked clipboard access",
    reload: "Reload subtitles",
    reloadHint: "Skips the copy saved on this computer",
    copyAll: "Copy all subtitles",
    exportSrt: "Export SRT",
    exportSrtHint: (mode) => `Matches the ${mode} view`,
    importFile: "Import subtitle file",
    importHint: "SRT or VTT, stored only on this computer",
    removeImport: "Remove imported subtitles",
    removeImportHint: "Switch back to the video site's subtitles",
    imported: (fileName) => `Imported ${fileName}. It's stored only on this computer`,
    removed: "Switched back to the video site's subtitles",
    segments: (count) => plural(count, "segment", "segments"),
    view: "Subtitle view",
    search: "Search subtitles",
    more: "More subtitle actions",
    tidying: (done, total) => `Tidying subtitles, ${done} of ${total} segments. It keeps going if you close the side panel`,
    tidyingPlain: "Tidying subtitles…",
    tidy: "Tidy up subtitles",
    tidyNote: "Adds punctuation and fixes misheard words, using your API credit. It finishes even if you close the side panel",
    showOriginal: "Show original subtitles",
    showTidied: "Show tidied subtitles",
    continueTidy: "Keep tidying",
    tidyUnfinished: (batches) => `${plural(batches, "batch wasn't", "batches weren't")} tidied. Click again to finish them`,
    tidyStopped: "Subtitle tidy-up stopped",
    translating: (done, total) => `Translating, ${done} of ${total} segments. It keeps going if you close the side panel`,
    translatingPlain: "Translating…",
    translateUnfinished: (batches) => `${plural(batches, "batch wasn't", "batches weren't")} translated. Switch to Translation again to fill ${batches === 1 ? "it" : "them"} in`,
    translateStopped: "Translation stopped",
    searchPlaceholder: "Search subtitles (original and translation)",
    matches: (count) => plural(count, "match", "matches"),
    backToCurrent: "Back to current line",
    loading: "Loading subtitles…",
    readTitle: "Read this video's subtitles",
    read: "Read subtitles",
    manualReadHint: "Open the transcript on the video page and wait for the text to appear, then click Read subtitles. Jianmu only reads what the transcript is already showing.",
    guided: (impact) => (impact ? `${impact} The video site's own guide is below.` : "The video site's own guide is below."),
  },
};
