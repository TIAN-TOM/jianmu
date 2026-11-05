// 把源码切成代码、注释和字符串三部分，结构规则才不会把注释当代码、把字符串当注释。
export interface Comment {
  readonly line: number; // 从 1 开始
  readonly text: string;
}

export interface SourceParts {
  readonly code: string; // 去掉注释，字符串原样保留
  readonly comments: readonly Comment[];
  readonly strings: readonly string[];
}

const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of))\s*$/;

export function splitSource(text: string): SourceParts {
  const comments: Comment[] = [];
  const strings: string[] = [];
  let code = "";
  let index = 0;
  let line = 1;

  const advance = (end: number): string => {
    const chunk = text.slice(index, end);
    line += chunk.split("\n").length - 1;
    index = end;
    return chunk;
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const start = line;
      const chunk = advance(end === -1 ? text.length : end);
      comments.push({ line: start, text: chunk.slice(2) });
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const start = line;
      const chunk = advance(end === -1 ? text.length : end + 2);
      comments.push({ line: start, text: chunk.slice(2, -2) });
      code += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(text, index, char);
      if (end === -1) {
        // 没闭合：多半是 JSX 文本里的撇号，当普通字符处理。
        code += advance(index + 1);
      } else {
        const chunk = advance(end + 1);
        strings.push(chunk.slice(1, -1));
        code += chunk;
      }
    } else if (char === "/" && REGEX_BEFORE.test(code.slice(-16))) {
      const end = findRegexEnd(text, index);
      code += advance(end === -1 ? index + 1 : end + 1);
    } else {
      code += advance(index + 1);
    }
  }
  return { code, comments, strings };
}

function findStringEnd(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index;
    else if (char === "\n" && quote !== "`") return -1;
  }
  return -1;
}

function findRegexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index;
  }
  return -1;
}
