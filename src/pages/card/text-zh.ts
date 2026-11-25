// 播放页卡片的界面文案，简体这份。它定下文案表的形状（CardText），英文那份（text-en.ts）和繁体那份（text-hant.ts）必须满足同一个类型。
// 模块顶层只放字面量和函数。带变量的文案写成函数。官方总结、章节名、结论这些内容不在这里，原样显示。
import type { OfficialSummaryView } from "../../shared/messages/transcript.ts";

export const CARD_ZH = {
  title: "简幕总结卡片",
  /** 收起那一行最前面的名字：有结论时跟着判断档的显示名，没有时写「总结」。 */
  name: (label: string) => `简幕 · ${label || "总结"}`,
  expand: "展开总结卡片",
  collapse: "收起总结卡片",
  headPanel: "侧边栏",
  openPanel: "打开侧边栏",
  overview: "AI 概览",
  official: "B 站官方总结",
  // 没有官方总结是常态，不占一行；要登录、没读到、还在读才说。
  officialNotes: {
    "need-login": "登录 B 站后才看得到官方总结。",
    failed: "这次没读到 B 站的官方总结。",
    pending: "正在读 B 站的官方总结…",
  } satisfies Readonly<Partial<Record<OfficialSummaryView["status"], string>>>,
  jumpTo: (time: string) => `跳到 ${time}`,
  section: (index: number) => `第 ${index} 段`,
  less: "收起",
  showAll: "展开全部",
  showAllSections: (count: number) => `展开全部 ${count} 段`,
  showAllChapters: (count: number) => `展开全部 ${count} 章`,
  writingVerdict: "正在写一句话结论…",
  stopping: "正在停止…",
  chunksDone: (done: number, total: number) => `已完成 ${done}/${total}`,
  auto: (progress: string) => `自动生成：${progress}`,
  autoStarting: "正在自动生成概览…",
  preparing: "正在准备…",
  stop: "停止",
  generate: "生成概览",
  openSettings: "打开设置",
  retry: "重试",
  openSettingsFailed: "没能打开设置页。可以打开侧边栏，点右上角的设置按钮。",

  // 卡片模型写的状态，按写出来那一刻的界面语言写。
  noCaptions: "这个视频没有 CC 字幕，生成不了概览。",
  needLogin: "登录 B 站后才读得到字幕、生成概览；也可以在侧边栏导入字幕文件。",
  notRead: "在侧边栏点「读取字幕」以后，这里才能生成概览。",
  notVideo: "这里不是视频播放页。",
  loading: "正在读取这个视频的总结…",
  loadTimeout: "读取超时，没读到这个视频的总结。",
  wrongVideo: "读到的不是当前视频的数据。",
  stopped: "已停止生成。",
  saveFailed: "概览已生成，但没能保存到本机，以后打开可能要重新生成。",
  stoppedSaved: (saved: number, total: number) => `已停止，做完的 ${saved}/${total} 存下了，剩下的可以在侧边栏补上。`,
  chaptersFirst: "章节还在生成，结论最后写。",
  noTab: "没能确认卡片所在的标签页，可以打开侧边栏看总结。",
  panelRefused: "浏览器没让卡片直接打开侧边栏，请点浏览器工具栏里的简幕图标。",
  /** 收起那一行上临时说的话。 */
  panelRefusedNote: "请点工具栏上的简幕图标",
};

export type CardText = typeof CARD_ZH;
