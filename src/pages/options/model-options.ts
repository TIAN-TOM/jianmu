// 模型候选列表的计算：按框里的字筛、标出命中的那几段、方向键移到第几项、列表朝上还是朝下开。

/** 框里的字按空白拆成几段，都小写；每一段都出现的模型才算匹配。 */
function terms(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

/** 按框里的字筛，顺序照服务商给的；框里没字就是全部。 */
export function matchModels(models: readonly string[], query: string): readonly string[] {
  const wanted = terms(query);
  if (wanted.length === 0) return models;
  return models.filter((model) => {
    const name = model.toLowerCase();
    return wanted.every((term) => name.includes(term));
  });
}

export interface ModelPart {
  readonly text: string;
  readonly hit: boolean;
}

/** 把模型名切成命中和没命中的几段，界面给命中的加重。每段字只标第一处，挨着或叠着的并成一段。 */
export function modelParts(model: string, query: string): readonly ModelPart[] {
  const name = model.toLowerCase();
  // 小写以后长度变了的名字（少数带变音符的字母）对不上位置，整段不标。
  if (name.length !== model.length) return [{ text: model, hit: false }];
  const hit = new Array<boolean>(model.length).fill(false);
  for (const term of terms(query)) {
    const at = name.indexOf(term);
    if (at >= 0) hit.fill(true, at, at + term.length);
  }
  const parts: ModelPart[] = [];
  let start = 0;
  for (let index = 1; index <= model.length; index += 1) {
    if (index < model.length && hit[index] === hit[start]) continue;
    parts.push({ text: model.slice(start, index), hit: hit[start] === true });
    start = index;
  }
  return parts;
}

/** 上下方向键以后停在第几项，到头绕回另一头；还没停在哪一项时，向下从第一项起、向上从最后一项起。 */
export function stepModel(key: "ArrowDown" | "ArrowUp", current: number, count: number): number {
  if (count <= 0) return -1;
  const delta = key === "ArrowDown" ? 1 : -1;
  const from = current >= 0 && current < count ? current : delta > 0 ? -1 : count;
  return (from + delta + count) % count;
}

/** 列表开在框的哪一边：下面放得下就朝下；放不下而上面更宽就朝上。 */
export function listSide(space: { readonly above: number; readonly below: number }, height: number): "top" | "bottom" {
  return height > space.below && space.above > space.below ? "top" : "bottom";
}
