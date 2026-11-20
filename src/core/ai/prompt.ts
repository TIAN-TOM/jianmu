// 提示词模板解析：取出 markdown 里某个小节的代码块，替换 {变量}；按输出语言填好模板里和语言有关的几处说法。
import type { OutputLang } from "../output-lang.ts";

export type PromptVariables = Readonly<Record<string, unknown>>;

/** 从提示词 markdown 里取出某个小节的代码块内容，并替换 {变量}。 */
export function extractPromptSection(
  markdown: string,
  heading: string,
  variables: PromptVariables = {},
): string {
  const marker = `## ${heading}`;
  const markerIndex = String(markdown || "").indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`提示词小节不存在：${heading}`);
  }

  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );

  const fence = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fence) {
    throw new Error(`提示词小节里没有代码块：${heading}`);
  }

  return fillPromptVariables(fence[1], variables);
}

/**
 * 一次扫描替换模板里全部 {变量}。逐个变量 split/join 的话，先替换进去的字幕或
 * 简介里若恰好写着 {chaptersText}，会被后面的那一轮再展开一次。
 * 没给值的占位符原样保留；替换用函数，值里的 $& 之类不会被当成替换模式。
 */
export function fillPromptVariables(
  template: string | null | undefined,
  variables: PromptVariables | null = {},
): string {
  const values: PromptVariables = variables && typeof variables === "object" ? variables : {};
  return String(template ?? "").replace(/\{(\w+)\}/g, (placeholder: string, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key] ?? "")
      : placeholder,
  );
}

/** 每种输出语言的那一节：代码块里每行一项「名字: 说法」，填进模板里同名的占位符。 */
export const LANG_SECTIONS: Readonly<Record<OutputLang, string>> = Object.freeze({ zh: "中文规则", en: "英文规则" });

const LANG_LINE = /^([A-Za-z][A-Za-z0-9_]*): (.*)$/;

/** 取出某种语言那一节的各项说法。认不出的行报错：写错了宁可发不出去，也不把占位符原样发给模型。 */
export function langVariables(markdown: string, lang: OutputLang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of extractPromptSection(markdown, LANG_SECTIONS[lang]).split("\n")) {
    const match = LANG_LINE.exec(line);
    if (!match) throw new Error(`提示词的${LANG_SECTIONS[lang]}有一行认不出：${line}`);
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

/**
 * 按输出语言填好模板里和语言有关的占位符，其余占位符原样留给发请求时再填。
 * 模板没有这一节时原样交回：不分语言的模板（和测试里的小模板）不必写这两节；正式模板两节都在，由提示词的测试守着。
 */
export function localizePrompt(markdown: string, lang: OutputLang): string {
  if (!String(markdown || "").includes(`## ${LANG_SECTIONS[lang]}`)) return markdown;
  return fillPromptVariables(markdown, langVariables(markdown, lang));
}
