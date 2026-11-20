// 几个页面共用的界面文案，英文这份。形状由中文那份（text-zh.ts）定，少一条、多一条或者函数签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { SharedText } from "./text-zh.ts";

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const SHARED_EN: SharedText = {
  close: "Close",
  back: "Back",
  serviceSaid: "What the service said",
  jumpTo: (time) => `Jump to ${time}`,

  modes: { label: "Mode", skim: "Skim", study: "Study" },

  chapters: {
    label: "Chapters",
    key: "Key chapter",
    heading: (count, keyCount) => (keyCount > 0 ? `${plural(count, "chapter", "chapters")}, ${keyCount} key` : plural(count, "chapter", "chapters")),
  },

  verdict: {
    label: "One-line verdict",
    stale: "Based on old subtitles",
    incomplete: "Incomplete",
    basis: {
      transcript: "Based on the subtitles",
      "official-summary": "Based on Bilibili's official summary, without reading the subtitles",
      "title-description": "Based on the title and description",
      "legacy-unknown": "Basis unknown (older version)",
    },
  },

  activation: {
    sections: { read: "What it reads", purpose: "What it's used for", store: "What's stored on this computer" },
    title: "See what Jianmu reads first",
    titleUpdated: "Jianmu needs to read something new",
    confirm: "Turn on Jianmu",
    confirmUpdated: "Keep using Jianmu",
    saving: "Turning on…",
    footnote: "Turning it on only reads and processes things on this computer. Sending anything to a model service needs your separate consent in settings.",
    showFull: "See the full notice",
  },

  stale: {
    title: "Jianmu needs to reload",
    impact: "Jianmu's files were updated, but the background is still running the old version, so this page can't be used yet. Your notes and overviews are kept when you reload. If you didn't tick “Remember the key on this computer”, you'll need to enter the key again.",
    reload: "Reload Jianmu",
    note: "Open Jianmu pages will close. Just open them again.",
  },

  setup: {
    notice: {
      key: "Your API key was cleared when the browser restarted or the extension updated. Enter it again in settings, or tick “Remember the key on this computer” so you don't have to",
      consent: "Subtitles work without setup. Overviews and Q&A need you to agree to the data notice in settings first",
      none: "Subtitles work without setup. Overviews and Q&A need an AI service set up first",
    },
    reason: {
      key: "Enter your API key again in settings first",
      consent: "Agree to the data notice in settings first",
      none: "Set up an AI service in settings first",
    },
    card: {
      key: "Your API key was cleared when the browser restarted or the extension updated. Enter it again in settings to generate an overview, or tick “Remember the key on this computer” so you don't have to.",
      consent: "To generate an overview, agree to the data notice in settings first.",
      none: "No AI service is set up yet. To generate an overview, add a provider and API key first.",
    },
  },
};
