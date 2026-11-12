// 卡片样张：页面测试时现编进测试用的扩展副本，不进产品包。数据都是自造的，内容故意很长，
// 正在生成，进度行、「停止」和「打开完整面板」都在。卡片的界面组件原样用，样式用产品的 card.css。
import { render } from "preact";
import { Card, type CardActions } from "../../../src/pages/card/card.tsx";
import type { CardView } from "../../../src/pages/card/model.ts";

const LONG = "这是一段自造的样例文字，用来把卡片撑得很高，看底部的按钮会不会被裁掉。";

const view: CardView = {
  visible: true,
  collapsed: false,
  phase: "loaded",
  title: `样例长视频：${LONG}`,
  official: {
    status: "ok",
    summary: LONG.repeat(6),
    outline: Array.from({ length: 12 }, (_, index) => ({
      title: `样例小节 ${index + 1}：${LONG}`,
      timestamp: index * 60,
      points: [{ timestamp: index * 60 + 10, content: LONG }],
    })),
  },
  analysis: {
    chapters: Array.from({ length: 16 }, (_, index) => ({ title: `样例章节 ${index + 1}：${LONG}`, timestampSeconds: index * 90 })),
    verdict: { verdict: "看概览就够", summary: LONG.repeat(2) },
  },
  verdictPending: false,
  noCaptions: false,
  task: { id: "sample", external: false, canceling: false, done: 3, total: 8, message: "" },
  settingsError: false,
  notice: { text: LONG, tone: "" },
};

const noop = (): void => undefined;
const actions: CardActions = { toggle: noop, generate: noop, cancel: noop, retry: noop, openPanel: noop, openSettings: noop, seek: noop };

const root = document.getElementById("app");
if (root) render(<Card view={view} aiReady={true} actions={actions} />, root);
