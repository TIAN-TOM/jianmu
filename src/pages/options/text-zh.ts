// 设置页的界面文案，简体这份。它定下文案表的形状（OptionsText），英文那份（text-en.ts）和繁体那份（text-hant.ts）必须满足同一个类型。
// 构建开关保护的功能的文案不放这里：画面分析在 frame-text.ts，YouTube 在 youtube-text.ts，只从开关分支引用。
// 模块顶层只放字面量和函数。带变量的文案写成函数。
import type { PresetId } from "../../core/ai/provider/endpoint.ts";
import type { DataConsentKind } from "../../core/consent.ts";
import type { Effort } from "../../core/notes/records.ts";
import type { BackupImportReply } from "../../shared/messages/data.ts";
import type { AccentTheme, AnalysisChunkMode, FeatureSlotId, ThemeMode } from "../../shared/settings-schema.ts";

/** 导出备份时各类记录的条数。 */
export interface ExportedCounts {
  readonly notes: number;
  readonly overviews: number;
  readonly qa: number;
  readonly translations: number;
}

export const OPTIONS_ZH = {
  title: "简幕设置",
  retry: "重试",
  cancel: "取消",
  activationLoading: "正在读取启用状态……",
  loadFailed: "读不出设置",
  loadFailedDetail: (reason: string) => `读不出设置：${reason}`,
  // 浏览器自己报的错（多半是英文）不放进界面时，拼在各句「…失败：」后面的原因。
  unexpected: "出了意外的错误。",

  appearance: {
    title: "外观",
    theme: "主题",
    themes: {
      ink: { name: "宣纸墨青", note: "暖白纸面，青黛点缀" },
      graphite: { name: "石墨靛蓝", note: "冷调石墨灰，靛蓝点缀" },
      ochre: { name: "暖岩赭石", note: "暖灰岩色，赭石点缀" },
    } satisfies Readonly<Record<AccentTheme, { name: string; note: string }>>,
    mode: "明暗",
    modes: { system: "跟随系统", light: "浅色", dark: "深色" } satisfies Readonly<Record<ThemeMode, string>>,
    modeHint: "播放页卡片的明暗跟着视频页，不跟这一项。",
    fontSize: "界面字号",
    fontSizes: { 100: "标准", 112: "较大", 125: "特大" },
    language: "语言",
    // 中文、English 两项各用自己的语言写，看不懂当前界面的人也认得出；只有这一项跟着界面语言。
    followBrowser: "跟随浏览器",
    languageHint: "之后生成的概览、问答和解释也用这种语言，已经生成的不变。",
  },

  card: {
    title: "播放页",
    hint: "关掉以后，打开侧边栏要点浏览器工具栏里的简幕图标。",
    toggle: "在视频右侧显示总结卡片",
  },

  triage: {
    title: "稍后再看粗筛",
    hint: "读你的 B 站稍后再看，按值不值得看分组、导出清单。读列表和官方总结不花 API 额度。",
    open: "打开稍后再看粗筛",
  },

  data: {
    title: "学习资料",
    hint: "只存在这台电脑上。备份不含 API 密钥、设置和导入的字幕文件；恢复时和本机已有的合并，本机独有的不会删。",
    exporting: "正在导出",
    export: "导出备份",
    importing: "正在恢复",
    import: "恢复备份",
    clearTitle: "清除本机数据",
    clearHint: "清除缓存不动笔记、概览、问答和设置。删除全部笔记和清除全部数据删了找不回来，要留着的先导出备份。",
    clearCache: "清除缓存",
    clearCacheQuestion: "清除字幕和视频信息的缓存，以及粗筛读到的列表？笔记、概览、问答和设置都留着。",
    clearCacheConfirm: "清除缓存",
    clearNotes: "删除全部笔记",
    clearNotesQuestion: "删除这台电脑上所有视频的笔记？删了找不回来。",
    clearNotesConfirm: "确认删除",
    clearAll: "清除全部数据",
    clearAllQuestion: "清除简幕在这台电脑上存的全部数据？笔记、概览、问答、导入的字幕文件、缓存、设置和密钥都会删掉，删了找不回来。",
    clearAllConfirm: "全部清除",
  },

  about: {
    title: "关于",
    version: "版本",
    releases: "更新记录",
    source: "源码",
    privacy: "隐私政策",
    issues: "反馈问题",
  },

  modes: {
    title: "速读和精读",
    hint: "不到 5 分钟的视频进精读，其余进速读；长视频在速读里播满 1 分钟会切到精读，可以撤销。在侧边栏顶上手动切一次，就记住这个 UP 主。",
    clear: "清除记住的 UP 主",
    clearQuestion: "清除以后，这些 UP 主的视频回到按时长选模式。",
    clearConfirm: "清除",
    cleared: "已清除，之后打开视频按时长进速读或精读。",
    clearFailed: "没能清除，请稍后再试。",
    count: (count: number) => `已记住 ${count} 个 UP 主或频道。`,
  },

  ai: {
    title: "AI 服务",
    hint: "选好服务商，填 API 密钥和模型名称。列表里没有的服务选「自定义」。密钥只发到所选服务商的地址。",
    regionTitle: "先选一类服务",
    regions: { domestic: "国内服务", overseas: "海外服务" },
    regionHint: "只是帮你预填下面的服务商。数据存在哪里，以各服务商为准。",
    provider: "服务商",
    presets: {
      anthropic: "Anthropic Claude",
      openai: "OpenAI",
      deepseek: "DeepSeek",
      gemini: "Google Gemini（OpenAI 兼容端点）",
      moonshot: "月之暗面 Kimi",
      zhipu: "智谱 GLM",
      dashscope: "阿里云百炼（通义千问）",
      siliconflow: "硅基流动 SiliconFlow",
      openrouter: "OpenRouter",
      ollama: "Ollama（本机）",
      custom: "自定义",
    } satisfies Readonly<Record<PresetId, string>>,
    // 密钥页链接前后的文字，空格写在这里，链接放中间。
    docsBefore: "到 ",
    docsLink: (provider: string) => `${provider} 的控制台`,
    docsAfter: " 创建 API 密钥。",
    protocol: "API 协议",
    protocols: {
      openai: "OpenAI 兼容（多数服务）",
      "openai-responses": "OpenAI Responses（OpenAI 官方）",
      anthropic: "Anthropic（Claude）",
    },
    protocolHint: "拿不准就选 OpenAI 兼容。",
    baseUrl: "API 地址",
    baseUrlHint: "填到版本号就行，只认 https。本机跑的服务（localhost、127.0.0.1）可以用 http。",
    apiKey: "API 密钥",
    clearKey: "清除密钥",
    clearKeyQuestion: "删除保存的 API 密钥？会话里和这台电脑上记住的都会删掉，删除后要重新填写才能用 AI 功能。",
    clearKeyConfirm: "删除密钥",
    keyHint: "默认关掉浏览器就不留了，下次要重填；简幕更新以后也一样。",
    // 只在选了 Ollama 或自定义时接在 keyHint 后面，句子之间要空格的语言把空格写在开头。
    localKeyHint: "本机的服务不要密钥时可以留空。",
    remember: "在这台电脑上记住密钥",
    // 保存密钥以后就地问的那一句，下面照写 rememberHint。两个按钮一样分量，不替用户选。
    rememberAsk: { label: "要不要记住密钥", question: "要把密钥记在这台电脑上吗？", yes: "记住", no: "不用" },
    rememberHint: "密钥会不加密地存在这台电脑上，重启浏览器后还能用。能看到这台电脑浏览器数据的人或程序可能拿到它，公用的电脑别勾。取消勾选马上删掉。密钥不进备份，也不跟浏览器账号同步。",
    model: "模型",
    modelPlaceholder: "填模型名称，或点右边的按钮获取",
    modelPick: "从列表里选",
    fetching: "正在获取",
    fetch: "获取模型列表",
    modelHint: "获取前会先保存上面填的内容。",
    featureModels: "按功能选模型（可选）",
    featureHint: "留空就用上面的默认模型。一句话结论、翻译、划词解释可以选更快更便宜的。换服务商时这里会清空。",
    featurePick: (feature: string) => `${feature}：从列表里选`,
    slots: {
      analysis: "概览",
      verdict: "一句话结论",
      rewrite: "翻译",
      tidy: "整理字幕",
      qa: "问答",
      notes: "笔记润色",
      explain: "划词解释",
    } satisfies Readonly<Record<Exclude<FeatureSlotId, "frame">, string>>,
    defaultModel: "默认模型",
    saving: "正在保存",
    save: "保存",
    testing: "正在测试",
    test: "测试连接",
    testAll: "测试全部模型",
    hostHint: "保存时浏览器会问是否允许简幕访问所选服务商的域名，只申请这一个域名。",
    advanced: "高级（推理强度、概览分块）",
    chunk: "概览分块",
    chunks: {
      auto: "自动（推荐）",
      short: "较短：请求数更多，更稳",
      long: "较长：请求数更少，更快",
      whole: "尽量整份：请求最少、章节最连贯，要上下文长的模型，容易超时",
    } satisfies Readonly<Record<AnalysisChunkMode, string>>,
    chunkHint: "多数模型用自动就好。内容有遗漏或请求超时选「较短」；模型的上下文够长时可以选「尽量整份」，超时就换回别的档。改了马上生效。",
  },

  consent: {
    title: "使用 AI 功能时会发送什么",
    headings: { category: "会发送", purpose: "用在", recipient: "发给谁", trigger: "什么时候发" } satisfies Readonly<Record<DataConsentKind, string>>,
    joiner: "；",
    updated: "说明有更新，新增的内容：",
    full: "查看完整说明",
    agree: "我已了解，同意在我使用 AI 功能时发送上述内容",
    agreeHint: "没勾选时不发任何 AI 请求。取消勾选马上生效。",
  },

  efforts: {
    title: "推理强度",
    hint: "档位越高，模型想得越久，越贵也越慢。模型做不到的档位按最接近的一档发，并在旁边标出。改了马上生效。",
    pending: "改了服务商或模型，保存以后再标实际档位。",
    labels: { off: "关", low: "低", medium: "中", high: "高" } satisfies Readonly<Record<Effort, string>>,
    cannotDisable: (lowest: string) => `这个模型关不掉思考，实际按最低的「${lowest}」档`,
    serviceDecides: "这个服务调不了推理强度，由服务自己决定",
    alwaysOff: "这个模型调不了推理强度，实际按「关」",
    missingLevel: (requested: string, effective: string) => `这个模型没有「${requested}」档，实际按「${effective}」档`,
    usageLevelByService: "由服务决定",
    usageHead: (level: string, otherModel: string | null) => `最近一次（${level}${otherModel === null ? "" : `，${otherModel}`}）`,
    usageLine: (head: string, body: string) => `${head}：${body}`,
    usageNone: "服务没回报用量",
    usageInput: (count: string) => `输入 ${count}`,
    usageOutput: (count: string) => `输出 ${count}`,
    usageReasoning: (count: string) => `思考 ${count}`,
    usageReasoningMissing: "思考没单独报",
    usageTotal: (count: string) => `合计 ${count}`,
    numberLocale: "zh-CN",
  },

  auto: {
    title: "打开就出结论",
    hint: "开着时，超过设定时长的视频一打开就自动生成概览和一句话结论，显示在播放页卡片上。后台打开的标签页也排队生成，打开开关时已经开着的也算。每个视频都花你的 API 额度，标签页开得越多花得越多；同时最多生成两个，10 分钟最多 40 个。外文视频不自动翻译。",
    instant: "改了马上生效。",
    toggle: "打开视频就出结论（花 API 额度）",
    askLabel: "打开前先同意数据说明",
    askUpdated: "数据说明有更新，打开前要先同意新增的内容：",
    ask: "打开前要先同意数据说明：",
    agreeAndOn: "同意并打开",
    minutes: "超过多少分钟的视频才生成",
    minutesHint: (min: number, max: number) => `${min} 到 ${max} 的整数，填 0 时每个视频都生成。`,
    aboveMax: (max: number, minutes: number) => `最多 ${max} 分钟，已改成 ${minutes}。`,
    belowMin: (min: number, minutes: number) => `最少 ${min} 分钟，已改成 ${minutes}。`,
    notWhole: (minutes: number) => `只能填整数，已改成 ${minutes}。`,
    notOn: (reason: string) => `没有打开：${reason}`,
  },

  status: {
    stale: "设置刚在别的页面改过，已按最新的设置重新载入，请再操作一次。",
    badAddress: "API 地址不合法。",
    permissionFailed: (reason: string) => `申请权限失败：${reason}`,
    noPermission: (origin: string) => `没有拿到 ${origin} 的访问权限，AI 功能用不了。`,
    notSaved: (reason: string) => `没有保存：${reason}`,
    saved: "已保存。",
    savedRemembered: "已保存，密钥已记在这台电脑上。",
    savedNotReady: (errors: string) => `已保存，但 AI 功能暂时用不了：${errors}`,
    modelsFailed: (reason: string) => `已保存，但没获取到模型列表：${reason}`,
    fetchedNone: "已保存，但服务没有返回模型，请手动填写模型名称。",
    fetchedHead: (count: number) => `已保存，找到 ${count} 个模型`,
    fetchedPick: (head: string) => `${head}，在模型框里选一个，再点「保存」。`,
    fetchedReady: (head: string, notes: readonly string[]) => `${head}，可以在模型框里直接选。${notes.join("")}`,
    notListed: (model: string) => `模型框里的「${model}」不在列表里，可能是旧名字或打错了，核对一下；有的服务也认列表外的别名。`,
    notReady: (errors: string) => `AI 功能暂时用不了：${errors}`,
    keyMissing: "这里还没有密钥：没勾「在这台电脑上记住密钥」时，重启浏览器或简幕更新以后要重新填。",
    connected: (feature: string, model: string, reply: string, truncated: boolean) => `${feature}（${model}）连接正常，回复「${reply}」${truncated ? "（回复被截断）" : ""}`,
    testFailed: (feature: string, reason: string) => `${feature}：${reason}`,
    rememberAfterSave: "点「保存」以后，密钥才会记在这台电脑上。",
    rememberOff: "已不再记住密钥：这台电脑上存的那份已删除，密钥只留在本次浏览器会话里。",
    rememberOffFailed: (reason: string) => `没有关掉：${reason}`,
    keyCleared: "已删除保存的 API 密钥。",
    keyClearFailed: (reason: string) => `删除失败：${reason}`,
  },

  backup: {
    fileName: (stamp: string) => `简幕备份-${stamp}.json`,
    exported: ({ notes, overviews, qa, translations }: ExportedCounts) => `已导出 ${notes} 条笔记、${overviews} 份概览、${qa} 条问答、${translations} 份译文和整理过的字幕。`,
    exportDropped: "导出失败：简幕的后台中途断开了，没导出来，再点一次「导出备份」。",
    importDropped: "恢复失败：简幕的后台中途断开了。可能已经导入了一部分，再选同一个文件导一次就行，已经导入的不会重复。",
    exportFailed: (reason: string) => `导出失败：${reason}`,
    importFailed: (reason: string) => `恢复失败：${reason}`,
    unreadable: "读不出这个文件：文件可能太大，或者已经被移走了。",
    notBackup: "读不懂这个文件，请选简幕导出的 JSON 备份。",
    clearFailed: (reason: string) => `清除失败：${reason}`,
    clearedNotes: "已删除全部笔记。",
    clearedAll: "已清除这台电脑上的全部数据，设置已恢复默认。",
    clearedCache: "已清除缓存。",
    importSummary: ({ counts, promptsDropped }: BackupImportReply) => {
      const { notes, overviews, qa, translations } = counts;
      let text = `合并完成：笔记新增 ${notes.added} 条、更新 ${notes.updated} 条，概览新增 ${overviews.added} 份、更新 ${overviews.updated} 份，问答新增 ${qa.added} 条`;
      // 第 1 版的备份没有译文，没有就不提。
      text += translations.added || translations.updated ? `，译文和整理过的字幕新增 ${translations.added} 份、补上 ${translations.updated} 份。` : "。";
      const skipped = [
        notes.skipped ? `${notes.skipped} 条笔记` : "",
        overviews.skipped ? `${overviews.skipped} 份概览` : "",
        qa.skipped ? `${qa.skipped} 条问答` : "",
        translations.skipped ? `${translations.skipped} 份译文` : "",
      ].filter(Boolean);
      if (skipped.length) text += `备份里有 ${skipped.join("、")}格式不对，已跳过。`;
      if (promptsDropped) text += "备份里的自定义提示词没有导入：现在只用内置的提示词。";
      return text;
    },
  },
};

export type OptionsText = typeof OPTIONS_ZH;
