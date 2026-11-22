// 去掉 TypeScript 源码里的注释，字符串、模板串（含 ${} 里套的代码和模板串）和正则字面量原样留着，注释里的换行留下。
// 仓库的 TypeScript 没有能在 Node 里调用的编译器接口，这里按词法自己走一遍。

// 斜杠前面是这些时，它开始的是正则字面量而不是除号。
const REGEX_AFTER_CHAR = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "yield", "await", "instanceof"]);

interface CodeFrame {
  readonly kind: "code";
  depth: number;
}

interface TemplateFrame {
  readonly kind: "template";
}

type Frame = CodeFrame | TemplateFrame;

export function stripComments(text: string): string {
  const stack: Frame[] = [{ kind: "code", depth: 0 }];
  let out = "";
  let index = 0;
  // 代码里上一个有意义的字符和上一个词，判断斜杠是不是正则用。
  let lastChar = "";
  let lastWord = "";

  const regexAllowed = (): boolean => lastChar === "" || REGEX_AFTER_CHAR.has(lastChar) || REGEX_AFTER_WORD.has(lastWord);
  const emitCode = (chunk: string): void => {
    out += chunk;
    const trimmed = chunk.trimEnd();
    if (!trimmed) return;
    lastChar = trimmed[trimmed.length - 1] ?? "";
    const word = /[A-Za-z_$][\w$]*$/.exec(trimmed);
    lastWord = word ? word[0] : "";
  };

  while (index < text.length) {
    const frame = stack[stack.length - 1] as Frame;
    const char = text[index] as string;
    const next = text[index + 1];

    if (frame.kind === "template") {
      if (char === "\\") {
        out += text.slice(index, index + 2);
        index += 2;
      } else if (char === "`") {
        out += char;
        index += 1;
        stack.pop();
        lastChar = "`";
        lastWord = "";
      } else if (char === "$" && next === "{") {
        out += "${";
        index += 2;
        stack.push({ kind: "code", depth: 0 });
        lastChar = "{";
        lastWord = "";
      } else {
        out += char;
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      const newlines = text.slice(index, stop).replace(/[^\n]/g, "");
      out += newlines || " ";
      index = stop;
    } else if (char === '"' || char === "'") {
      const end = quotedEnd(text, index, char);
      emitCode(text.slice(index, end));
      index = end;
    } else if (char === "`") {
      out += char;
      index += 1;
      stack.push({ kind: "template" });
    } else if (char === "/" && regexAllowed()) {
      const end = regexEnd(text, index);
      emitCode(text.slice(index, end));
      index = end;
    } else if (char === "{") {
      frame.depth += 1;
      emitCode(char);
      index += 1;
    } else if (char === "}") {
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop();
        out += char;
        lastChar = "";
        lastWord = "";
      } else {
        frame.depth -= 1;
        emitCode(char);
      }
      index += 1;
    } else {
      emitCode(char);
      index += 1;
    }
  }
  return out;
}

// 字符串的结束位置（结束引号之后）。没闭合时到行尾。
function quotedEnd(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index + 1;
    else if (char === "\n") return index;
  }
  return text.length;
}

// 正则字面量的结束位置（含标志）。字符类里的斜杠不算结束。
function regexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return index;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < text.length && /[a-z]/i.test(text[end] as string)) end += 1;
      return end;
    }
  }
  return text.length;
}
