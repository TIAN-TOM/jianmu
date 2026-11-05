// 提示词模板解析：取出 markdown 里某个小节的代码块，替换 {变量}。
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
