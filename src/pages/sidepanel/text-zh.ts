// 侧边栏的界面文案，简体这份。它定下文案表的形状（PanelText），英文那份（text-en.ts）和繁体那份（text-hant.ts）必须满足同一个类型。
// 构建开关保护的功能的文案不放这里：解释当前画面在 frame-text.ts，YouTube 的启用说明在 youtube-text.ts，
// 代开文字稿的说明在 open-transcript.ts，沿用同意在 carried.tsx，都只从开关分支引用。
// 模块顶层只放字面量和函数。带变量的文案写成函数。
import type { WindowRunView } from "../../shared/messages/batch.ts";
import type { PlayerFailure } from "./player.ts";
import type { TranscriptMode } from "../../shared/messages/transcript.ts";

/** 本窗口全部生成的进度里要写的几种条数。 */
export interface BatchProgress {
  readonly total: number;
  readonly completed: number;
  readonly partial: number;
  readonly failed: number;
  readonly canceled: number;
  readonly skipped: number;
}

export const PANEL_ZH = {
  title: "简幕",
  loading: "正在读取…",
  retry: "重试",
  stop: "停止",
  cancel: "取消",
  inUse: "正在用",
  openSettings: "打开设置",
  notFound: (query: string) => `没有找到「${query}」`,
  optionsFailed: "打不开设置页，可以在扩展管理里打开简幕的选项。",
  remembered: (author: string, study: boolean) => `已记住：${author ? `${author}的视频` : "这个频道的视频"}以后先进${study ? "精读" : "速读"}`,
  forget: "不记",
  forgotten: (bilibili: boolean): string => (bilibili ? "好，不记这个 UP 主" : "好，不记这个频道"),
  copied: "已复制",
  copyFailed: "没能复制，浏览器拒绝了剪贴板",

  head: {
    loadingVideo: "正在读取视频",
    switchTrack: "换字幕语言",
    imported: (fileName: string) => `导入：${fileName}`,
    notes: "笔记",
  },

  noVideo: {
    title: "打开一个 B 站视频",
    impact: "在 B 站的视频播放页打开侧边栏，就能读字幕、生成概览、提问和记笔记。",
  },

  dock: {
    ask: "针对这个视频提问",
    history: "问答记录",
    saveNote: "存笔记",
    noPosition: "还不知道播放到哪，等视频页连上简幕再记",
  },

  notices: {
    connect: "视频页还没连上简幕，刷新后才能跳转和跟着播放滚动",
    reloadPage: "刷新视频页",
    switchedToStudy: "已切到精读",
    backToSkim: "回到速读",
  },

  player: {
    VIDEO_CHANGED: "页面上的视频已经换了，刷新侧边栏或回到原视频再试。",
    AD_PLAYING: "正在播广告，等广告放完再跳。",
    NO_VIDEO: "页面上没找到视频。",
    UNREACHABLE: "视频页还没连上简幕，刷新视频页后才能跳转。",
  } satisfies Readonly<Record<PlayerFailure, string>>,

  batch: {
    label: "本窗口全部生成",
    counting: "正在清点本窗口的视频…",
    notice: (concurrency: number) => `确认以后逐个读字幕、交给你设置的模型服务生成概览，会用掉 API 额度；同时进行的请求最多 ${concurrency} 个。关掉侧边栏也会接着做完。`,
    start: (count: number) => `开始生成 ${count} 个`,
    gotIt: "知道了",
    progressLabel: "本窗口的进度",
    stopping: "正在停止…",
    stopAll: "全部停止",
    canceled: "已停止",
    failed: "生成失败",
    partialLabel: "不完整的概览",
    partialReason: "有一部分没生成出来，切到这个视频点「补上缺的部分」",
    stopped: (reason: string) => `这一批停下了。${reason}`,
    empty: "本窗口没有打开的视频。",
    /** 确认前的说明：本窗口几个视频（不算要逐个打开的）、跳过几个、要新生成几个。 */
    head: (total: number, existing: number, running: number, todo: number): string => {
      const head = `本窗口有 ${total} 个视频`;
      const skipped = [existing ? `${existing} 个已有概览` : "", running ? `${running} 个正在生成` : ""].filter(Boolean);
      if (!todo) return `${head}，${skipped.join("、")}，没有要新生成的。`;
      const fresh = `要新生成 ${todo} 个。`;
      if (!skipped.length) return `${head}，${fresh}`;
      if (skipped.length === 1) return `${head}，跳过 ${skipped[0]}的，${fresh}`;
      return `${head}，跳过 ${existing + running} 个（${skipped.join("、")}），${fresh}`;
    },
    /** 要逐个打开的 YouTube 视频，head 是前面那句（没有时是空串）。 */
    openEach: (count: number, head: string) =>
      head ? `${head}另有 ${count} 个 YouTube 视频需逐个打开，在视频页上点读取字幕。` : `本窗口的 ${count} 个 YouTube 视频需逐个打开，在视频页上点读取字幕。`,
    progress: (counts: BatchProgress): string => {
      const parts = [`本窗口：已完成 ${counts.completed} / ${counts.total}`];
      if (counts.partial) parts.push(`其中 ${counts.partial} 个不完整`);
      if (counts.failed) parts.push(`失败 ${counts.failed}`);
      if (counts.canceled) parts.push(`已停止 ${counts.canceled}`);
      if (counts.skipped) parts.push(`跳过 ${counts.skipped}`);
      return parts.join("，");
    },
    withStop: (progress: string, stop: string) => `${progress}。${stop}`,
    stop: {
      "rate-limited": "被 B 站限流，后面的没再读，过几分钟再单独重试。",
      "need-login": "B 站说要先登录，后面的没再读，登录后再单独重试。",
      source: "B 站回的内容读不懂，后面的没再读，过一阵再单独重试。",
    } satisfies Readonly<Record<NonNullable<WindowRunView["stop"]>, string>>,
  },

  guides: {
    official: "B 站官方总结",
    creator: "UP 主分段",
    queued: "B 站现在没有这个视频的官方总结。",
    needLogin: "登录 B 站以后才看得到官方总结。",
    failed: "这次没问到官方总结，过一会儿会再问。",
    pending: "正在问官方总结…",
  },

  skim: {
    saveAsNote: "存为笔记",
    savedNote: "已保存",
    chapterCues: "这一段的字幕",
    quotes: "金句",
    writingVerdict: "正在写一句话结论…",
    verdictFromOfficial: "用官方总结写结论",
    verdictFromOfficialNote: "只发一次小请求，不通读字幕",
    nothingToExport: "还没有可以导出的内容",
    generating: (done: number, total: number) => `正在生成概览 ${done}/${total}`,
    generatingPlain: "正在生成概览…",
    stopGenerating: "停止生成",
    failedChunks: "有一部分没生成出来，可以只补这部分。",
    saveFailed: "概览已经生成，但没能存进本机。",
    canceled: "停在中途，做完的已经存下。",
    overviewLabel: "模型生成的概览",
    retryFailed: "补上缺的部分",
    regenerate: "重新生成",
    needTranscript: "要先读到字幕",
    generate: "生成概览",
    exportStudy: "导出学习稿",
    transcriptLabel: "字幕",
  },

  study: {
    currentChapter: "当前章节",
    jumpToChapter: (time: string) => `跳到这一章开头 ${time}`,
  },

  notes: {
    saved: "已存为笔记",
    duplicate: "这个时间点已经有一条笔记",
    deleted: "已删除这条笔记",
    scopes: { video: "本视频", all: "全部" },
    scopeLabel: "笔记范围",
    polishing: "正在润色",
    actions: "笔记操作",
    edit: "编辑",
    delete: "删除",
    deleteHint: "删了找不回来",
    copyText: "复制正文",
    copyLink: "复制链接",
    content: "笔记内容",
    save: "保存",
    nothingToExport: "没有可以导出的笔记",
    allNotes: "全部笔记",
    count: (count: number) => `${count} 条`,
    exportMarkdown: "导出 Markdown",
    searchPlaceholder: "搜索笔记、标题或 UP 主",
    searchLabel: "搜索笔记",
    emptyTitle: "还没有笔记",
    emptyImpact: "在概览里把金句存为笔记，或者在播放器上点笔记图标、按 n。",
  },

  qa: {
    title: "问答",
    actions: "问答操作",
    delete: "删除",
    deleted: "已删除这条问答",
    truncated: "回答被截断了，可能不完整。",
    copyAnswer: "复制回答",
    unsaved: "这条回答没能存进问答历史。",
    citations: "引用的字幕",
    placeholder: "针对这个视频提问，Enter 发送",
    ask: "提问",
    hint: "每个问题单独回答，追问时把问题写完整。",
    answering: "正在字幕里找相关内容并回答…",
    emptyTitle: "还没有问答",
    failed: "没能回答这个问题。",
    pending: "正在回答一个问题",
  },

  transcript: {
    modes: { original: "原文", translated: "译文", bilingual: "双语" } satisfies Readonly<Record<TranscriptMode, string>>,
    explain: "解释",
    explainTitle: (selection: string) => `解释：${selection}`,
    explaining: "正在请模型解释…",
    translateHint: "会请模型翻译没译过的段落，要用 API 额度；关掉侧边栏也会译完",
    file: "字幕",
    copied: "已复制全部字幕",
    reload: "重新读取字幕",
    reloadHint: "不看本机缓存",
    copyAll: "复制全部字幕",
    exportSrt: "导出 SRT",
    exportSrtHint: (mode: string) => `内容跟着${mode}视图`,
    importFile: "导入字幕文件",
    importHint: "SRT 或 VTT，只存在这台电脑上",
    removeImport: "移除导入的字幕",
    removeImportHint: "换回视频网站的字幕",
    imported: (fileName: string) => `已导入 ${fileName}，只存在这台电脑上`,
    removed: "已换回视频网站的字幕",
    segments: (count: number) => `共 ${count} 段`,
    view: "字幕视图",
    search: "搜索字幕",
    more: "更多字幕操作",
    tidying: (done: number, total: number) => `正在整理字幕 ${done}/${total} 段，关掉侧边栏也会继续`,
    tidyingPlain: "正在整理字幕…",
    tidy: "整理字幕",
    tidyNote: "补标点、改同音错字，要用 API 额度；关掉侧边栏也继续",
    showOriginal: "看原始字幕",
    showTidied: "看整理后的字幕",
    continueTidy: "接着整理",
    tidyUnfinished: "还有一部分没整理完",
    tidyStopped: "整理停了",
    translating: (done: number, total: number) => `正在翻译 ${done}/${total} 段，关掉侧边栏也会继续`,
    translatingPlain: "正在翻译…",
    translateUnfinished: "还有一部分没译完",
    translateStopped: "翻译停了",
    continueTranslate: "接着翻译",
    searchPlaceholder: "搜索字幕（原文和译文都会搜）",
    matches: (count: number) => `${count} 处`,
    backToCurrent: "回到当前句",
    loading: "正在读取字幕…",
    readTitle: "读取这个视频的字幕",
    read: "读取字幕",
    manualReadHint: "先在视频页上打开文字稿，等文字出来，再点读取。简幕只读文字稿里已经显示的内容。",
    guided: (impact: string) => `${impact}下面是视频网站给的导读。`,
  },
};

export type PanelText = typeof PANEL_ZH;
