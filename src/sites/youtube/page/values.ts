// YouTube 页面一侧和后台读取共用的纯值：自动生成字幕的类别标记、问答随机标记的格式、按对象取字段、把页面文字压成一行。
// 主世界的小桥也带入它，所以不导入别的模块；顶层只放字面量和函数。

/** 字幕轨的类别里，标着自动生成的那一种。 */
export const AUTO_KIND = "asr";
/** 内容脚本问主世界时带的随机标记。 */
export const TOKEN = /^[\w-]{8,64}$/;

export type Fields = Readonly<Record<string, unknown>>;
/** 是普通对象就按字段表交回，数组和别的值是 null。 */
export const fields = (value: unknown): Fields | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null);

/** 连续的空白压成一个空格，去掉首尾空白；没有文字时是空串。 */
export const squash = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
