// 模型输出的宽容解析：包了围栏、前后夹话、尾逗号、输出中途被截断的 JSON 都尽量读出来。

/**
 * 截断修复：输出撞到 max_tokens 或传输中断时，JSON 会停在字符串或
 * 括号中间。扫描出未闭合的部分原样补齐，保住已生成的内容。
 * 信封层（传输）与内容层（parseLooseJson）共用这一个实现。
 */
export function repairTruncatedJson(text: string): string {
  let inString = false;
  let danglingEscape = false;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        if (i + 1 >= text.length) {
          danglingEscape = true;
          break;
        }
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      stack.pop();
    }
  }
  let repaired = text;
  if (danglingEscape) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  // 截断恰好停在逗号后（长数组最常见的截断点）时，悬尾逗号必须先剥掉，
  // 否则补完括号的 ",]}" 依然是非法 JSON，修复等于白修。
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) {
    repaired += stack.pop() === "[" ? "]" : "}";
  }
  return repaired;
}

/**
 * 解析模型返回的 JSON，容忍它常犯的小错：
 * 包了 markdown 围栏、在 JSON 前后加了一句话、结尾多一个逗号、
 * 输出中途被截断。
 */
export function parseLooseJson(text: unknown): unknown {
  let cleaned = String(text || "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // 依次升级修复力度：尾逗号 → 截断补齐。
    const noTrailingComma = cleaned.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(noTrailingComma);
    } catch {
      return JSON.parse(repairTruncatedJson(noTrailingComma));
    }
  }
}
