// B 站读取模块共用：把平台返回里的文字值换成去掉首尾空白的字符串，不是字符串的当空串。
export const plainText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
