// 校验设置时给用户看的提示，中文那份定形状，英文那份少一条、多一条，类型检查就报错。
// 地址不对的几句在 core/ai/provider/text.ts，没同意数据说明那一句在 core/consent.ts。模块顶层只放字面量和函数。
import type { OutputLang } from "../core/output-lang.ts";

const CHECK_ZH = {
  missingKey: "请填写 API 密钥（没选记住密钥时，浏览器重启、扩展更新后要重新填）。",
  missingModel: "请填写模型名称，或点击「拉取模型列表」进行选择。",
};

export type SettingsCheckText = typeof CHECK_ZH;

const CHECK_EN: SettingsCheckText = {
  missingKey: "Enter your API key. Unless you chose to remember it, you need to enter it again after restarting the browser or updating the extension.",
  missingModel: "Enter a model name, or click “Fetch model list” and choose one.",
};

/** 指定语言那份提示。不传语言时是中文。 */
export const settingsCheckText = (lang: OutputLang = "zh"): SettingsCheckText => (lang === "en" ? CHECK_EN : CHECK_ZH);
