// 图标数据只有几何：路径只含绘图指令和数字，坐标都在网格里，组件按数据画元素，不拼标记文本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ICON_GRID, ICONS, MARK_SETS, type IconPart } from "../../../../../src/pages/shared/ui/icons.ts";

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;

/** 图形的坐标都在 width × height 的网格里；横坐标比宽，纵坐标比高。 */
function problemsOf(name: string, parts: readonly IconPart[], width: number, height = width): string[] {
  const within = (value: number, limit: number): boolean => Number.isFinite(value) && value >= 0 && value <= limit;
  const problems: string[] = [];
  if (parts.length === 0) problems.push(`${name}：没有图形`);
  for (const part of parts) {
    if (part.kind === "path") {
      if (!PATH_DATA.test(part.d)) problems.push(`${name}：路径里有绘图指令以外的字符`);
      // 指令后面的绝对坐标（大写指令）都在网格里，一对一对地是横、纵坐标。
      for (const [, numbers] of part.d.matchAll(/[MLC]([^A-Za-z]*)/g)) {
        ((numbers ?? "").match(/-?\d*\.?\d+/g) ?? []).forEach((value, index) => {
          if (!within(Number(value), index % 2 === 0 ? width : height)) problems.push(`${name}：坐标 ${value} 出了网格`);
        });
      }
    } else if (part.kind === "circle") {
      if (!within(part.cx - part.r, width) || !within(part.cx + part.r, width) || !within(part.cy - part.r, height) || !within(part.cy + part.r, height)) {
        problems.push(`${name}：圆出了网格`);
      }
    } else if (!within(part.x, width) || !within(part.y, height) || !within(part.x + part.width, width) || !within(part.y + part.height, height)) {
      problems.push(`${name}：方块出了网格`);
    }
  }
  return problems;
}

test("界面图标都在 16px 网格里，路径只含绘图指令", () => {
  const problems = Object.entries(ICONS).flatMap(([name, parts]) => problemsOf(name, parts, ICON_GRID));
  assert.deepEqual(problems, []);
});

test("三套判断标记都在各自的网格里，路径只含绘图指令", () => {
  const problems = Object.entries(MARK_SETS).flatMap(([set, shapes]) =>
    Object.entries(shapes).flatMap(([shape, drawing]) => problemsOf(`${set}/${shape}`, drawing.parts, drawing.width, drawing.height)),
  );
  assert.deepEqual(problems, []);
});

test("核对能拦下夹带标记文本和出界的数据", () => {
  assert.equal(problemsOf("坏", [{ kind: "path", d: 'M1 1"/><script>' }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [{ kind: "path", d: "M1 1L20 2" }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [{ kind: "circle", cx: 15, cy: 8, r: 3 }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [], ICON_GRID).length, 1);
});
