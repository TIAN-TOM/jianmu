// 卡片样张：页面测试时现编进测试用的扩展副本，不进产品包。数据都是自造的，内容故意很长。
// 地址带 #full 时是全部展开、正在生成的样子（进度行、「停止」和「打开侧边栏」都在），带 #collapsed 时是收起的一行，
// 带 #official 时是还没有概览、只有一段不长的官方总结，不带时是刚打开的默认样子；
// 「展开全部」和官方总结那一行点得动。卡片的界面组件原样用，样式用产品的 card.css。
import { signal } from "@preact/signals";
import { render } from "preact";
import { Card, type CardActions } from "../../../src/pages/card/card.tsx";
import type { CardView } from "../../../src/pages/card/model.ts";

const LONG = "这是一段自造的样例文字，用来把卡片撑得很高，看底部的按钮会不会被裁掉。";
const full = location.hash === "#full";
// 只有官方总结：正文一百来个字，提纲 3 段。很窄的卡片加大字号时三行放不下，很宽的卡片标准字号时放得下；
// 宽窄差得开，换一套字体、字宽不一样也照样成立。
const officialOnly = location.hash === "#official";
const SHORT_SUMMARY = "这是一段自造的官方总结，一共一百来个字，用来看正文被截成三行以后，底下还有没有藏着的字。卡片很宽的时候三行放得下，一个字都不藏；卡片很窄、字号又调大的时候三行放不下，后面的字就被截掉了，这时候要有地方点开看全。";

const view = signal<CardView>({
  visible: true,
  collapsed: location.hash === "#collapsed",
  phase: "loaded",
  title: `样例长视频：${LONG}`,
  official: {
    status: "ok",
    summary: officialOnly ? SHORT_SUMMARY : LONG.repeat(6),
    outline: Array.from({ length: officialOnly ? 3 : 12 }, (_, index) => ({
      title: officialOnly ? `样例小节 ${index + 1}` : `样例小节 ${index + 1}：${LONG}`,
      timestamp: index * 60,
      points: officialOnly ? [] : [{ timestamp: index * 60 + 10, content: LONG }],
    })),
  },
  analysis: officialOnly ? null : {
    chapters: Array.from({ length: 16 }, (_, index) => ({ title: `样例章节 ${index + 1}：${LONG}`, timestampSeconds: index * 90 })),
    // 重点是第 2 章和第 11 章：一个时间四位、一个五位，章节名要和别的章对齐。
    verdict: { verdict: "可以看", summary: LONG.repeat(2), keyStarts: [90, 900] },
  },
  verdictPending: false,
  noCaptions: false,
  needLogin: false,
  task: full ? { id: "sample", external: false, auto: false, canceling: false, done: 3, total: 8, message: "" } : null,
  settingsError: false,
  notice: full ? { text: LONG, tone: "" } : null,
  showAll: full,
  officialOpen: full,
});

const noop = (): void => undefined;
const actions: CardActions = {
  toggle: noop,
  generate: noop,
  cancel: noop,
  retry: noop,
  openPanel: noop,
  openSettings: noop,
  seek: noop,
  toggleShowAll: () => void (view.value = { ...view.value, showAll: !view.value.showAll }),
  toggleOfficial: () => void (view.value = { ...view.value, officialOpen: !view.value.officialOpen }),
};

function App() {
  return <Card view={view.value} aiReady={true} actions={actions} />;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
