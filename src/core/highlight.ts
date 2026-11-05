// 搜索命中高亮：把文本按关键词切片，大小写不敏感的包含匹配，和笔记筛选同一套语义。
// 只返回片段不碰 DOM，渲染层用 textContent 加 <mark> 拼，绝不走 innerHTML。
export interface MatchSegment {
  readonly text: string;
  readonly hit: boolean;
}

// splitMatches("Java 和 javascript", "java")
//   => [{text:"Java",hit:true},{text:" 和 ",hit:false},{text:"java",hit:true},{text:"script",hit:false}]
// 关键词为空或全是空白时，原样返回一个未命中片段；文本也为空时返回空数组。
export function splitMatches(text: unknown, query: unknown): MatchSegment[] {
  const source = String(text ?? "");
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return source ? [{ text: source, hit: false }] : [];
  }

  const haystack = source.toLowerCase();
  if (!haystack.includes(needle)) {
    return [{ text: source, hit: false }];
  }

  const segments: MatchSegment[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    if (index > cursor) {
      segments.push({ text: source.slice(cursor, index), hit: false });
    }
    // 命中片段保留原文的大小写，不显示被小写的版本。
    segments.push({ text: source.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor), hit: false });
  }
  return segments;
}

// 片段里是否存在命中：渲染层据此决定走高亮路径还是原样 textContent。
export function hasMatch(segments: readonly MatchSegment[]): boolean {
  return segments.some((segment) => segment.hit);
}
