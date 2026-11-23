// 侧边栏的界面文案，繁体这份。形状由简体那份（text-zh.ts）定，少一条、多一条或者函数签名不一样，类型检查就报错。
// 构建开关保护的功能的文案不放这里，见 text-zh.ts 开头。模块顶层只放字面量和函数。
import type { PanelText } from "./text-zh.ts";

export const PANEL_HANT: PanelText = {
  title: "簡幕",
  loading: "正在讀取…",
  retry: "重試",
  stop: "停止",
  cancel: "取消",
  inUse: "使用中",
  openSettings: "打開設定",
  notFound: (query) => `找不到「${query}」`,
  optionsFailed: "打不開設定頁，可以在擴充功能管理裡打開簡幕的選項。",
  remembered: (author, study) => `已記住：${author ? `${author}的影片` : "這個頻道的影片"}以後先進${study ? "精讀" : "速讀"}`,

  head: {
    loadingVideo: "正在讀取影片",
    switchTrack: "換字幕語言",
    imported: (fileName) => `匯入：${fileName}`,
    notes: "筆記",
  },

  noVideo: {
    title: "打開一部 B 站影片",
    impact: "在 B 站的影片播放頁打開側邊欄，就能讀字幕、生成概覽、提問和記筆記。",
  },

  dock: {
    ask: "針對這部影片提問",
    history: "問答紀錄",
    saveNote: "存筆記",
    noPosition: "還不知道播放到哪裡，等影片頁連上簡幕再記",
  },

  notices: {
    connect: "影片頁還沒連上簡幕，重新整理後才能跳轉和跟著播放捲動",
    reloadPage: "重新整理影片頁",
    switchedToStudy: "已切到精讀",
    backToSkim: "回到速讀",
    autoPaused: {
      quota: "額度用完，打開就出結論已暫停。手動生成成功一次，或在設定頁關掉再開啟就會恢復",
      key: "金鑰被拒，打開就出結論已暫停。手動生成成功一次，或在設定頁關掉再開啟就會恢復",
    },
  },

  player: {
    VIDEO_CHANGED: "頁面上的影片已經換了，重新整理側邊欄或回到原來的影片再試。",
    AD_PLAYING: "正在播廣告，等廣告播完再跳。",
    NO_VIDEO: "頁面上找不到影片。",
    UNREACHABLE: "影片頁還沒連上簡幕，重新整理影片頁後才能跳轉。",
  },

  batch: {
    label: "本視窗全部生成",
    counting: "正在清點本視窗的影片…",
    notice: (concurrency) => `確認以後逐一讀取字幕、交給你設定的模型服務生成概覽，會用掉 API 額度；同時進行的請求最多 ${concurrency} 個。關掉側邊欄也會繼續做完。`,
    start: (count) => `開始生成 ${count} 部`,
    gotIt: "知道了",
    progressLabel: "本視窗的進度",
    stopping: "正在停止…",
    stopAll: "全部停止",
    collapse: "收合",
    canceled: "已停止",
    failed: "生成失敗",
    partialLabel: "不完整的概覽",
    partialReason: "有分塊沒有生成成功，切到這部影片點選「補失敗塊」",
    stopped: (reason) => `這一批停下了。${reason}`,
    empty: "本視窗沒有打開的影片。",
    head: (total, existing, running, todo) => {
      const head = `本視窗有 ${total} 部影片`;
      const skipped = [existing ? `${existing} 部已有概覽` : "", running ? `${running} 部正在生成` : ""].filter(Boolean);
      if (!todo) return `${head}，${skipped.join("、")}，沒有要新生成的。`;
      const fresh = `要新生成 ${todo} 部。`;
      if (!skipped.length) return `${head}，${fresh}`;
      if (skipped.length === 1) return `${head}，略過 ${skipped[0]}的，${fresh}`;
      return `${head}，略過 ${existing + running} 部（${skipped.join("、")}），${fresh}`;
    },
    openEach: (count, head) =>
      head ? `${head}另有 ${count} 部 YouTube 影片需要逐一打開，在影片頁上點選讀取字幕。` : `本視窗的 ${count} 部 YouTube 影片需要逐一打開，在影片頁上點選讀取字幕。`,
    progress: (counts) => {
      const parts = [`本視窗：已完成 ${counts.completed} / ${counts.total}`];
      if (counts.partial) parts.push(`其中 ${counts.partial} 部不完整`);
      if (counts.failed) parts.push(`失敗 ${counts.failed}`);
      if (counts.canceled) parts.push(`已停止 ${counts.canceled}`);
      if (counts.skipped) parts.push(`略過 ${counts.skipped}`);
      return parts.join("，");
    },
    withStop: (progress, stop) => `${progress}。${stop}`,
    stop: {
      "rate-limited": "被 B 站限流，後面的沒有再讀，過幾分鐘再個別重試。",
      "need-login": "B 站要求先登入，後面的沒有再讀，登入後再個別重試。",
      source: "B 站傳回的內容看不懂，後面的沒有再讀，過一陣子再個別重試。",
    },
  },

  guides: {
    official: "影片網站的官方總結",
    creator: "UP 主分段",
    queued: "影片網站目前沒有這部影片的官方總結。",
    needLogin: "登入影片網站以後才看得到官方總結。",
    failed: "這次沒有取得官方總結，過一會兒會再試。",
    pending: "正在取得官方總結…",
  },

  skim: {
    saveAsNote: "存為筆記",
    savedNote: "已儲存",
    chapterCues: "這一段的字幕",
    quotes: "金句",
    writingVerdict: "正在寫一句話結論…",
    verdictFromOfficial: "用官方總結寫結論",
    verdictFromOfficialNote: "只傳送一次小請求，不通讀字幕",
    nothingToExport: "還沒有可以匯出的內容",
    generating: (done, total) => `正在生成概覽 ${done}/${total} 塊`,
    generatingPlain: "正在生成概覽…",
    stopGenerating: "停止生成",
    failedChunks: (count) => `有 ${count} 塊沒有生成成功，可以只補這幾塊。`,
    saveFailed: "概覽已經生成，但沒能存進本機。",
    canceled: (count) => `停在中途，已完成的 ${count} 塊存下來了。`,
    overviewLabel: "模型生成的概覽",
    retryFailed: "補失敗塊",
    regenerate: "重新生成",
    needTranscript: "要先讀到字幕",
    generate: "生成概覽",
    exportStudy: "匯出學習稿",
    transcriptLabel: "字幕",
  },

  study: {
    currentChapter: "目前章節",
    jumpToChapter: (time) => `跳到這一章開頭 ${time}`,
  },

  notes: {
    saved: "已存為筆記",
    duplicate: "這個時間點已經有一則筆記",
    deleted: "已刪除這則筆記",
    scopes: { video: "本影片", all: "全部" },
    scopeLabel: "筆記範圍",
    polishing: "正在整理",
    actions: "筆記操作",
    edit: "編輯",
    delete: "刪除",
    deleteHint: "刪了就找不回來",
    content: "筆記內容",
    save: "儲存",
    nothingToExport: "沒有可以匯出的筆記",
    allNotes: "全部筆記",
    count: (count) => `${count} 則`,
    exportMarkdown: "匯出 Markdown",
    searchPlaceholder: "搜尋筆記、標題或 UP 主",
    searchLabel: "搜尋筆記",
    emptyTitle: "還沒有筆記",
    emptyImpact: "在概覽裡把金句存為筆記，或者在播放器上點選筆記圖示、按 n。",
  },

  qa: {
    title: "問答",
    delete: "刪除這則問答",
    truncated: "回答被截斷了，可能不完整。",
    unsaved: "這則回答沒能存進問答紀錄。",
    citations: "引用的字幕",
    placeholder: "針對這部影片提問，按 Enter 傳送",
    ask: "提問",
    hint: "每個問題單獨回答，追問時請把問題寫完整。",
    answering: "正在字幕裡找相關內容並回答…",
    emptyTitle: "還沒有問答",
    failed: "沒能回答這個問題。",
    pending: "正在回答一個問題",
  },

  transcript: {
    modes: { original: "原文", translated: "譯文", bilingual: "雙語" },
    explain: "解釋",
    explainTitle: (selection) => `解釋：${selection}`,
    explaining: "正在請模型解釋…",
    translateHint: "會請模型翻譯還沒譯過的段落，要用 API 額度；關掉側邊欄也會譯完",
    file: "字幕",
    copied: "已複製全部字幕",
    copyFailed: "沒能複製，瀏覽器拒絕存取剪貼簿",
    reload: "重新讀取字幕",
    reloadHint: "不看本機快取",
    copyAll: "複製全部字幕",
    exportSrt: "匯出 SRT",
    exportSrtHint: (mode) => `內容跟著${mode}檢視`,
    importFile: "匯入字幕檔案",
    importHint: "SRT 或 VTT，只存在這台電腦上",
    removeImport: "移除匯入的字幕",
    removeImportHint: "換回影片網站的字幕",
    imported: (fileName) => `已匯入 ${fileName}，只存在這台電腦上`,
    removed: "已換回影片網站的字幕",
    segments: (count) => `共 ${count} 段`,
    view: "字幕檢視",
    search: "搜尋字幕",
    more: "更多字幕操作",
    tidying: (done, total) => `正在整理字幕 ${done}/${total} 段，關掉側邊欄也會繼續`,
    tidyingPlain: "正在整理字幕…",
    tidy: "整理字幕",
    tidyNote: "補標點、改同音錯字，要用 API 額度；關掉側邊欄也會繼續",
    showOriginal: "看原始字幕",
    showTidied: "看整理後的字幕",
    continueTidy: "繼續整理",
    tidyUnfinished: (batches) => `有 ${batches} 批沒整理完，可以再點一次補上`,
    tidyStopped: "整理已停止",
    translating: (done, total) => `正在翻譯 ${done}/${total} 段，關掉側邊欄也會繼續`,
    translatingPlain: "正在翻譯…",
    translateUnfinished: (batches) => `有 ${batches} 批沒譯成，可以再切一次譯文補上`,
    translateStopped: "翻譯已停止",
    searchPlaceholder: "搜尋字幕（原文和譯文都會搜尋）",
    matches: (count) => `${count} 處`,
    backToCurrent: "回到目前這句",
    loading: "正在讀取字幕…",
    readTitle: "讀取這部影片的字幕",
    read: "讀取字幕",
    manualReadHint: "先在影片頁上打開轉錄稿，等文字出來，再點選讀取。簡幕只讀取轉錄稿裡已經顯示的內容。",
    guided: (impact) => `${impact}下面是影片網站提供的導讀。`,
  },
};
