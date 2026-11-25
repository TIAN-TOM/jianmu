// 主题样式表：每套主题完整、两种明暗下的对比度、浏览器自己画的部分跟着主题。读样式表文本算，不开浏览器。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCENT_THEMES, DEFAULTS } from "../../../src/shared/settings-schema.ts";
import {
  contrast,
  cssRules,
  customProperties,
  evaluateColor,
  over,
  propertiesOf,
  ruleBody,
  variablesFor,
  type Rgba,
  type ThemeModeName,
} from "../../helpers/theme-css.ts";

const CSS = readFileSync(new URL("../../../static/theme.css", import.meta.url), "utf8");
const RULES = cssRules(CSS);
const THEMES = Object.keys(ACCENT_THEMES);
const MODES: Readonly<Record<ThemeModeName, string>> = { light: "浅色", dark: "深色" };
const PREFIX: Readonly<Record<ThemeModeName, "l" | "d">> = { light: "l", dark: "d" };

// 每套主题都要有的原始色值，浅色 --l-*、深色 --d-* 各一组。
const RAW = [
  "bg",
  "surface",
  "sunken",
  "hover",
  "active",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-faint",
  "accent",
  "accent-strong",
  "accent-text",
  "accent-text-strong",
  "on-accent",
  "mark",
  "key",
  "verdict",
];

// 默认主题写在 :root 上，其余主题各有一块覆盖。
function rawValues(theme: string): Record<string, string> {
  return theme === DEFAULTS.accentTheme ? propertiesOf(RULES, ":root") : propertiesOf(RULES, `:root[data-accent-theme="${theme}"]`);
}

/** 这套主题、这种明暗下解出一个变量的颜色。 */
function palette(theme: string, mode: ThemeModeName): (name: string) => Rgba {
  const variables = variablesFor(RULES, theme, DEFAULTS.accentTheme, mode);
  return (name) => evaluateColor(variables, `var(${name})`);
}

function eachLook(check: (theme: string, mode: ThemeModeName, color: (name: string) => Rgba, label: string) => void): void {
  for (const theme of THEMES) {
    for (const mode of Object.keys(MODES) as ThemeModeName[]) check(theme, mode, palette(theme, mode), `${theme} ${MODES[mode]}`);
  }
}

function assertContrast(label: string, foreground: Rgba, background: Rgba, minimum: number): void {
  const ratio = contrast(foreground, background);
  assert.ok(ratio >= minimum, `${label} 只有 ${ratio.toFixed(2)}:1，要 ${minimum}:1`);
}

test("每套主题都是完整的：浅色、深色两组原始色值一个不缺", () => {
  for (const theme of THEMES) {
    const values = rawValues(theme);
    for (const prefix of Object.values(PREFIX)) {
      for (const name of RAW) assert.match(values[`--${prefix}-${name}`] ?? "", /^#[0-9a-f]{6}$/, `${theme} 缺 --${prefix}-${name}`);
    }
  }
  // 样式表里的主题块和设置模块的主题表一一对应，不多不少。
  const blocks = RULES.flatMap((rule) => /^:root\[data-accent-theme="([a-z]+)"\]$/.exec(rule.selector)?.[1] ?? []);
  assert.deepEqual(blocks.sort(), THEMES.filter((theme) => theme !== DEFAULTS.accentTheme).sort());
});

// 页面上会出现的文字色，和它们会落在的几种底色（--panel-bg 是侧边栏的底）。
// 当前句和按下去的底色（--bg-active）上只有正文和时间戳，状态色不会落在上面，单独查。
const TEXTS = [
  "--text",
  "--text-strong",
  "--text-muted",
  "--text-faint",
  "--accent-text",
  "--accent-text-strong",
  "--danger",
  "--warn",
  "--ok",
  "--verdict-go",
  "--verdict-fair",
  "--verdict-skip",
  "--verdict-unknown",
];
const SURFACES = ["--bg", "--card", "--panel-bg", "--bg-subtle", "--bg-hover"];

test("每套主题、每种明暗下，文字色和主按钮上的字都过 WCAG AA", () => {
  eachLook((theme, _mode, color, label) => {
    for (const surface of SURFACES) {
      for (const text of TEXTS) assertContrast(`${label}：${text} 在 ${surface} 上`, color(text), color(surface), 4.5);
    }
    // 看不看的当前句铺分隔线那一档灰，上面的时间戳换成正文色（次要文字色在这层灰上不够），所以这一套不查 --accent-text。
    const onActive = theme === "band" ? ["--text", "--text-strong", "--accent-text-strong"] : ["--text", "--text-strong", "--accent-text", "--accent-text-strong"];
    for (const text of onActive) assertContrast(`${label}：${text} 在 --bg-active 上`, color(text), color("--bg-active"), 4.5);
    // 输入框里的字和占位字（次要文字色）落在输入框自己的底色上。
    for (const text of ["--text", "--text-muted"]) assertContrast(`${label}：${text} 在 --input 上`, color(text), color("--input"), 4.5);
    for (const fill of ["--accent", "--accent-strong"]) assertContrast(`${label}：--on-accent 在 ${fill} 上`, color("--on-accent"), color(fill), 4.5);
  });
});

test("叠在底色上的选中文字、提示行、警告徽标，播放头、重点、时间轨和控件边框，五套主题乘两种明暗都够对比度", () => {
  // 半透明的行底色先叠到页面底色和卡片上再算；播放头、重点圆点、章节段这类图形要 3:1。
  // 只查页面上真会出现的组合：带底色的状态徽标只有「信息不足」的警告一种，危险和完成的淡底上没有同色的字。
  const rows: readonly (readonly [string, string])[] = [
    ["--text-strong", "--accent-soft-strong"],
    ["--accent-text", "--accent-soft"],
    ["--accent-text-strong", "--accent-soft"],
    ["--warn", "--warn-soft"],
    ["--accent-text", "--warn-soft"],
  ];
  eachLook((_theme, _mode, color, label) => {
    for (const base of ["--bg", "--card"]) {
      for (const [text, row] of rows) assertContrast(`${label}：${text} 在 ${row} 叠 ${base} 上`, color(text), over(color(row), color(base)), 4.5);
    }
    for (const base of ["--bg", "--card", "--bg-hover"]) {
      for (const shape of ["--mark", "--mark-key", "--rail-key", "--rail-played"]) assertContrast(`${label}：${shape} 在 ${base} 上`, color(shape), color(base), 3);
      assertContrast(`${label}：--rail-seg 叠 ${base}`, over(color("--rail-seg"), color(base)), color(base), 3);
    }
    // 输入框、下拉框的边框：和框里的底色、框所在的卡片都差 3:1。
    for (const base of ["--input", "--card"]) assertContrast(`${label}：--border-strong 在 ${base} 上`, color("--border-strong"), color(base), 3);
  });
});

// 各套主题版面上自己的颜色：页面上真会出现的前景和底色的配对，文字要 4.5:1，图形和控件要 3:1。
// 时间码的刻度空格（--meter-off）贴着卡片色只有 1.4 到 1.9:1、细边框按钮的边框（--border）只有 1.4:1，画板就是这么取的，
// 判断词和按钮上的字已经说清了意思，这两对不在这里查。
const OWN_PAIRS: Readonly<Record<string, readonly (readonly [string, string, number])[]>> = {
  timecode: [
    ["--on-mark", "--mark", 4.5], // 当前句红底胶囊上的时间码
    ["--text", "--bg", 4.5], // 当前句铺的页面底色
    ["--length-bar", "--panel-bg", 3], // 时长条
    ["--text", "--meter-off", 3], // 刻度和进度条里填上的格子挨着空格
    ["--mark", "--meter-off", 3], // 进度条上的播放头
  ],
  marker: [
    ["--on-highlight", "--highlight", 4.5], // 荧光笔划过的字
    ["--on-highlight", "--panel-bg", 4.5], // 只划下半截，字的上半截落在底色上
    ["--accent", "--card", 3], // 播放页卡片底部主按钮的钢笔蓝细边框
  ],
  band: [
    ...["go", "fair", "skip", "unknown"].flatMap((band) => [
      [`--band-${band}-ink`, `--band-${band}`, 4.5] as const, // 判断词和记号
      [`--band-${band}-say`, `--band-${band}`, 4.5] as const, // 色带上的结论句
    ]),
    ["--band-unknown-ink", "--band-unknown-alt", 4.5], // 斜纹的另一种颜色
    ["--band-unknown-say", "--band-unknown-alt", 4.5],
  ],
  pinkblue: [
    ["--verdict", "--key-tint", 4.5], // 判断胶囊里的字和记号
    ["--mark-key", "--key-tint", 4.5], // 重点章节的时间
    ["--text", "--key-tint", 4.5], // 重点章节名
    ["--accent-text", "--now-tint", 4.5], // 当前句的时间
    ["--text", "--now-tint", 4.5], // 当前句
    ["--mark", "--now-tint", 3], // 当前句左边的竖线
    ["--mark", "--panel-bg", 3], // 模式切换的短横线
  ],
  redblack: [
    ["--text", "--key-tint", 4.5], // 「重点」小标签
    ["--panel-bg", "--text", 4.5], // 当前句反显的时间码、选中的模式
    ["--mark", "--panel-bg", 3], // 判断前的红色记号、播放进度
    ["--mark", "--bg-subtle", 3], // 播放进度挨着它的轨道
    ["--text", "--chip", 4.5], // 播放页卡片底部灰底胶囊上的「展开全部」
    ["--text", "--bg-active", 4.5], // 同一个胶囊悬停时
  ],
};

test("各套主题版面上自己的颜色：真会出现的配对都够对比度", () => {
  assert.deepEqual(Object.keys(OWN_PAIRS).sort(), [...THEMES].sort());
  eachLook((theme, _mode, color, label) => {
    for (const [front, back, minimum] of OWN_PAIRS[theme] ?? []) assertContrast(`${label}：${front} 在 ${back} 上`, color(front), color(back), minimum);
  });
});

test("看不看的色带取自画板：深色是原色 18% 叠在底色上，判断词用原色、结论句用正文色", () => {
  const values = rawValues("band");
  // 推荐看、可以看按这条规则算；可跳过、信息不足本来就是灰，深色照画板写的那两种灰。
  const own = ["go", "fair"] as const;
  const mix = (hex: string): string => {
    const [r, g, b] = evaluateColor({}, hex);
    const [br, bg, bb] = evaluateColor({}, values["--d-surface"] ?? "");
    return `#${[[r, br], [g, bg], [b, bb]].map(([top = 0, base = 0]) => Math.round(top * 0.18 + base * 0.82).toString(16).padStart(2, "0")).join("")}`;
  };
  for (const band of own) {
    assert.equal(values[`--d-band-${band}`], mix(values[`--l-band-${band}`] ?? ""), band);
    assert.equal(values[`--d-band-${band}-ink`], values[`--l-band-${band}`], `${band}：深色的判断词用原色`);
  }
  const dark = palette("band", "dark");
  for (const band of ["go", "fair", "skip", "unknown"]) assert.deepEqual(dark(`--band-${band}-say`), dark("--text"), `${band}：深色的结论句用正文色`);
});

test("设置页的主题预览和播放页按钮用的颜色，和 theme.css 一致", () => {
  for (const theme of THEMES) {
    const values = rawValues(theme);
    const info = ACCENT_THEMES[theme as keyof typeof ACCENT_THEMES];
    // 标志色和它上面的字色都取自这套主题的原始色值；播放页按钮亮起来时是字色配标志色，带一句提示字，要 4.5:1。
    const own = (color: string): boolean => Object.values(values).includes(color);
    assert.ok(own(info.swatch), `${theme} 的 swatch 是这套主题自己的颜色`);
    assert.ok(own(info.onSwatch), `${theme} 的 onSwatch 是这套主题自己的颜色`);
    assertContrast(`${theme} 的 onSwatch 配 swatch`, evaluateColor({}, info.onSwatch), evaluateColor({}, info.swatch), 4.5);
    for (const [mode, prefix] of Object.entries(PREFIX)) {
      assert.deepEqual(
        { ...info.preview[mode as ThemeModeName] },
        {
          bg: values[`--${prefix}-bg`],
          card: values[`--${prefix}-surface`],
          text: values[`--${prefix}-text`],
          accent: values[`--${prefix}-accent`],
        },
        `${theme} ${mode}`,
      );
    }
  }
});

test("深色的两套选择器写的是同一份语义变量", () => {
  // data-theme-mode 承接脚本写下的结果，media query 兜首屏；两处漏改一处，
  // 「跟随系统」的人就会看到和手动选深色不一样的颜色。
  const explicit = customProperties(ruleBody(RULES, ':root[data-theme-mode="dark"]'));
  const media = customProperties(ruleBody(RULES, ':root:not([data-theme-mode="light"])', "@media (prefers-color-scheme: dark)"));
  assert.deepEqual(media, explicit);
  assert.match(ruleBody(RULES, ':root:not([data-theme-mode="light"])', "@media (prefers-color-scheme: dark)"), /color-scheme:\s*dark;/);
});

test("滚动条跟着主题：拇指在五套主题、两种明暗下和底色、卡片、凹陷层、悬停底色都差 ≥ 3:1", () => {
  const root = ruleBody(RULES, ":where(html)");
  assert.match(root, /accent-color:\s*var\(--accent\);/, "复选框、单选、进度条用主题的强调色");
  assert.match(root, /scrollbar-color:\s*var\(--scrollbar-thumb\) transparent;/, "写在根上，所有滚动区域继承");
  assert.match(propertiesOf(RULES, ":root")["--scrollbar-thumb"] ?? "", /^color-mix\(in oklab, var\(--text-faint\) \d+%, transparent\)$/, "拇指是注释文字色压低不透明度");
  eachLook((_theme, _mode, color, label) => {
    for (const under of SURFACES) {
      const base = color(under);
      assertContrast(`${label}：滚动条拇指在 ${under} 上`, over(color("--scrollbar-thumb"), base), base, 3);
    }
  });
});

test("搜索框的清除按钮、自动填充的底色用主题变量画，不露出浏览器默认的蓝色", () => {
  const cancel = ruleBody(RULES, ':where(input[type="search"])::-webkit-search-cancel-button');
  assert.match(cancel, /(?:^|\s)appearance:\s*none;/, "去掉浏览器自带的蓝色 ×");
  assert.match(cancel, /background-color:\s*var\(--text-faint\);/);
  assert.match(cancel, /(?:^|\s)mask:\s*var\(--search-clear-icon\)/);
  assert.match(propertiesOf(RULES, ":root")["--search-clear-icon"] ?? "", /^url\("data:image\/svg\+xml,/, "图标内联，不加载外部文件");
  assert.match(ruleBody(RULES, ':where(input[type="search"])::-webkit-search-cancel-button:hover'), /var\(--text\)/);

  // 自动填充的浅蓝底被浏览器用 !important 锁着，只能用内阴影盖住，聚焦时光圈叠在外面
  assert.match(ruleBody(RULES, ":where(input):autofill"), /box-shadow:\s*inset 0 0 0 100vmax var\(--input\);/);
  assert.match(ruleBody(RULES, ":where(input):autofill:focus"), /inset 0 0 0 100vmax var\(--input\),\s*0 0 0 3px var\(--accent-soft-strong\)/);
});

test("设置页的下拉框交给网页来画：展开的选项列表、箭头和选中项都用主题变量", () => {
  // 支持 base-select 的浏览器（Chrome 135+）才换，更早的版本照旧是原生下拉框。
  const at = "@supports (appearance: base-select)";
  assert.match(ruleBody(RULES, "select, ::picker(select)", at), /^\s*appearance: base-select;\s*$/);
  assert.match(ruleBody(RULES, "::picker(select)", at), /background:\s*var\(--card\);/);
  assert.match(ruleBody(RULES, "::picker(select)", at), /color:\s*var\(--text\);/);
  assert.match(ruleBody(RULES, "select::picker-icon", at), /color:\s*var\(--text-muted\);/);
  assert.match(ruleBody(RULES, "option:checked", at), /color:\s*var\(--accent-text-strong\);[\s\S]*background:\s*var\(--accent-soft\);/);
  assert.match(ruleBody(RULES, "option:focus-visible", at), /outline:\s*var\(--focus-ring\);/, "键盘在列表里移动时看得见");
});

test("界面字号只改根字号，默认是标准一档；减少动态效果时动效时长归零", () => {
  assert.equal(propertiesOf(RULES, ":root")["--ui-font-zoom"], "1");
  assert.match(ruleBody(RULES, "html"), /^\s*font-size:\s*calc\(100% \* var\(--ui-font-zoom\)\);\s*$/);
  assert.doesNotMatch(CSS, /(?:^|[\s;{])zoom\s*:/, "不用 zoom 缩放页面");
  const reduced = customProperties(ruleBody(RULES, ":root", "@media (prefers-reduced-motion: reduce)"));
  const durations = Object.keys(propertiesOf(RULES, ":root")).filter((name) => name.startsWith("--dur"));
  assert.ok(durations.length > 0);
  assert.deepEqual(Object.keys(reduced).sort(), durations.sort());
  for (const value of Object.values(reduced)) assert.equal(value, "0ms");
});

test("字体跟着界面语言：简体和英文用简体字形的字体，繁体界面（html lang 是 zh-Hant）换成繁体字形的；五套主题都只用无衬线", () => {
  const base = propertiesOf(RULES, ":root");
  assert.match(base["--font-sans"] ?? "", /"PingFang SC".*"Microsoft YaHei"/);
  const hant = propertiesOf(RULES, ":root:lang(zh-Hant)");
  assert.deepEqual(Object.keys(hant), ["--font-sans"]);
  assert.match(hant["--font-sans"] ?? "", /"PingFang TC".*"Microsoft JhengHei"/);
  assert.doesNotMatch(hant["--font-sans"] ?? "", /\bSC\b|YaHei|Hiragino Sans GB/);
  assert.doesNotMatch(CSS, /--font-serif|Songti|Serif/, "不再有宋体");
});

test("圆角跟着主题：每套主题写全小、中、大三档", () => {
  const radii: Readonly<Record<string, readonly [string, string, string]>> = {
    timecode: ["2px", "4px", "10px"],
    marker: ["4px", "6px", "12px"],
    band: ["6px", "8px", "16px"],
    pinkblue: ["4px", "6px", "12px"],
    redblack: ["4px", "8px", "12px"],
  };
  assert.deepEqual(Object.keys(radii).sort(), [...THEMES].sort());
  for (const theme of THEMES) {
    const values = rawValues(theme);
    assert.deepEqual([values["--radius-sm"], values["--radius-md"], values["--radius-lg"]], radii[theme], theme);
  }
});

test("判断档位四档同一个颜色，靠形状和文字区分", () => {
  const root = propertiesOf(RULES, ":root");
  for (const name of ["--verdict-go", "--verdict-fair", "--verdict-skip", "--verdict-unknown"]) assert.equal(root[name], "var(--verdict)", name);
});
