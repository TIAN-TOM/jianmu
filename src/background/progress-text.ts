// 后台写进任务进度和任务收尾的那句话：页面在进度条和失败提示里原样显示。按任务冻结时的语言写（gen.outputLang，旧任务没有就是中文）。
// 中文那份定形状，英文、繁体那份少一条、多一条或签名不一样，类型检查就报错。繁体那份在 progress-text-hant.ts。模块顶层只放字面量和函数。
import { inLang, type OutputLang } from "../core/output-lang.ts";
import { PROGRESS_HANT } from "./progress-text-hant.ts";

const PROGRESS_ZH = {
  preparing: "正在准备…",
  qaSearching: "正在检索相关内容…",
  qaAnswering: "正在组织回答…",
  qaShrinking: "字幕太长，这个模型装不下，缩小范围再问一次…",
  translateBatch: (done: number, total: number) => `正在处理 ${done}/${total}`,
  translateRetry: "正在重试没成的部分",
  chunkRetry: "正在重试没成的部分",
  verdict: "正在写一句话结论…",
  overviewChunk: (done: number, total: number) => `正在生成 ${done}/${total}`,
  merging: "正在合并概览…",
  refillChunk: (done: number, total: number) => `正在补 ${done}/${total}`,
  refillIncomplete: "还有部分没补上",
  unclaimed: "没有收到生成请求，已停止",
  canceled: "已取消",
  done: "已完成",
  failed: "生成失败",
};

export type ProgressText = typeof PROGRESS_ZH;

const PROGRESS_EN: ProgressText = {
  preparing: "Getting ready…",
  qaSearching: "Finding the relevant parts…",
  qaAnswering: "Putting the answer together…",
  qaShrinking: "The subtitles are too long for this model. Asking again with less…",
  translateBatch: (done, total) => `Processed ${done} of ${total}`,
  translateRetry: "Retrying the parts that failed",
  chunkRetry: "Retrying the parts that failed",
  verdict: "Writing the one-line verdict…",
  overviewChunk: (done, total) => `Generated ${done} of ${total}`,
  merging: "Merging the overview…",
  refillChunk: (done, total) => `Filled in ${done} of ${total}`,
  refillIncomplete: "Some parts still couldn't be filled in",
  unclaimed: "Stopped because no generation request arrived",
  canceled: "Cancelled",
  done: "Done",
  failed: "Generation failed",
};

/** 指定语言那份说法。不传语言时是中文。 */
export const progressText = (lang: OutputLang = "zh"): ProgressText => inLang(lang, PROGRESS_ZH, PROGRESS_EN, PROGRESS_HANT);
