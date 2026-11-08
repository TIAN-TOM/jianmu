// 图标数据只有几何：路径只含绘图指令和数字，坐标都在网格里，组件按数据画元素，不拼标记文本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ICON_GRID, ICONS, MARK_GRID, MARK_PARTS, type IconPart } from "../../../../../src/pages/shared/ui/icons.ts";

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;

function problemsOf(name: string, parts: readonly IconPart[], grid: number): string[] {
  const inside = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= grid;
  const problems: string[] = [];
  if (parts.length === 0) problems.push(`${name}：没有图形`);
  for (const part of parts) {
    if (part.kind === "path") {
      if (!PATH_DATA.test(part.d)) problems.push(`${name}：路径里有绘图指令以外的字符`);
      // 指令后面的绝对坐标（大写指令）都在网格里。
      for (const [, numbers] of part.d.matchAll(/[MLC]([^A-Za-z]*)/g)) {
        for (const value of (numbers ?? "").match(/-?\d*\.?\d+/g) ?? []) {
          if (!inside(Number(value))) problems.push(`${name}：坐标 ${value} 出了网格`);
        }
      }
    } else if (part.kind === "circle") {
      if (!inside(part.cx - part.r) || !inside(part.cx + part.r) || !inside(part.cy - part.r) || !inside(part.cy + part.r)) {
        problems.push(`${name}：圆出了网格`);
      }
    } else if (!inside(part.x) || !inside(part.y) || !inside(part.x + part.width) || !inside(part.y + part.height)) {
      problems.push(`${name}：方块出了网格`);
    }
  }
  return problems;
}

test("界面图标都在 16px 网格里，路径只含绘图指令", () => {
  const problems = Object.entries(ICONS).flatMap(([name, parts]) => problemsOf(name, parts, ICON_GRID));
  assert.deepEqual(problems, []);
});

test("判断标记都在 14px 网格里", () => {
  const problems = Object.entries(MARK_PARTS).flatMap(([name, parts]) => problemsOf(name, parts, MARK_GRID));
  assert.deepEqual(problems, []);
});

test("核对能拦下夹带标记文本和出界的数据", () => {
  assert.equal(problemsOf("坏", [{ kind: "path", d: 'M1 1"/><script>' }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [{ kind: "path", d: "M1 1L20 2" }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [{ kind: "circle", cx: 15, cy: 8, r: 3 }], ICON_GRID).length, 1);
  assert.equal(problemsOf("坏", [], ICON_GRID).length, 1);
});
