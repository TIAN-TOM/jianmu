// 端到端里的打开就出结论：另开一个获得焦点的窗口。打开开关（门槛调到 20 分钟）以后，不到门槛的短视频、后台打开的标签页、
// 没有焦点的窗口里的前台视频都不生成；后台打开的那个切到前台才生成，卡片上出结论，概览请求只发一次，切走再切回来不再发。
// 关掉开关以后在前台打开长视频，不发模型请求。要在侧边栏主流程之后跑：那时已登录、配好模型服务。
import { AUTO_SAMPLES, ANTHROPIC } from "./fixtures.mjs";
import { watchPage } from "./mock-server.mjs";
import { storedSettings } from "./settings.mjs";

const { long: AUTO_LONG, short: AUTO_SHORT, background: AUTO_BACKGROUND } = AUTO_SAMPLES;

/** 确认某件事没发生要看多久。 */
const QUIET_MS = 2000;

/**
 * @param {{ until: (label: string, read: () => unknown) => Promise<any>, evaluate: (session: string, expression: string) => Promise<any>,
 *   cdp: { send: (method: string, params?: object, sessionId?: string) => Promise<any> }, launcher: string,
 *   mock: { models: { calls: { video: string, kind: string }[] } } }} deps
 */
export async function autoFlow({ until, evaluate, cdp, launcher, mock }) {
  const callsFor = (video, kind) => mock.models.calls.filter((call) => call.video === video.id && call.kind === kind).length;
  const anyCallFor = (video) => mock.models.calls.some((call) => call.video === video.id);

  /** 一段时间里一直没发生。 */
  async function quiet(label, happened) {
    const deadline = Date.now() + QUIET_MS;
    while (Date.now() < deadline) {
      if (await happened()) throw new Error(`不该发生：${label}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  const pages = async (video) => (await cdp.send("Target.getTargets")).targetInfos.filter((info) => info.type === "page" && info.url === watchPage(video.id)).length;

  /** 找到显示这个视频标题、又有这段文字的那张卡片。 */
  const attached = new Map();
  async function cardShows(video, text) {
    return until(`「${video.title}」的卡片上出现「${text}」`, async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      for (const info of targetInfos) {
        if (info.type !== "iframe" || !info.url.includes("/pages/card.html")) continue;
        let session = attached.get(info.targetId);
        if (!session) {
          ({ sessionId: session } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true }));
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, session).catch(() => {});
          attached.set(info.targetId, session);
        }
        const shown = await evaluate(session, `document.getElementById("card")?.textContent ?? ""`).catch(() => "");
        if (shown.includes(video.title) && shown.includes(text)) return true;
      }
      return false;
    });
  }

  const writeSettings = async (auto) => {
    const { local } = await storedSettings(ANTHROPIC, auto);
    await evaluate(launcher, `chrome.storage.local.set(${JSON.stringify(local)}).then(() => true)`);
  };
  const newTab = (windowId, video, active) =>
    evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(watchPage(video.id))}, active: ${active} }).then((tab) => tab.id)`);

  // 打开开关，门槛调到 20 分钟：在获得焦点的新窗口里打开 12 分钟的视频，卡片读完也不生成。
  await writeSettings({ minutes: 20 });
  const focused = await evaluate(launcher, `chrome.windows.create({ url: ${JSON.stringify(watchPage(AUTO_SHORT.id))}, focused: true }).then((win) => win.id)`);
  await cardShows(AUTO_SHORT, "生成概览");
  await quiet("不到门槛的视频发了模型请求", () => anyCallFor(AUTO_SHORT));
  console.log("✓ 打开就出结论：没到设定时长的视频不生成");

  // 后台打开的长视频、没有焦点的窗口里的前台长视频，都不生成。
  const background = await newTab(focused, AUTO_BACKGROUND, false);
  await until("后台打开的播放页加载", async () => (await pages(AUTO_BACKGROUND)) === 1);
  await evaluate(launcher, `chrome.windows.create({ url: ${JSON.stringify(watchPage(AUTO_LONG.id))}, focused: false }).then(() => true)`);
  await until("没有焦点的窗口里的播放页加载", async () => (await pages(AUTO_LONG)) === 1);
  await quiet("后台标签页或没有焦点的窗口发了模型请求", () => anyCallFor(AUTO_BACKGROUND) || anyCallFor(AUTO_LONG));
  console.log("✓ 打开就出结论：后台打开的标签页、没有焦点的窗口里的前台视频都不生成");

  // 后台打开的那个第一次切到前台：生成一次，卡片上出结论。
  await evaluate(launcher, `chrome.tabs.update(${background}, { active: true }).then(() => true)`);
  await cardShows(AUTO_BACKGROUND, "模拟服务写的一句话结论");
  const counts = { analysis: callsFor(AUTO_BACKGROUND, "analysis"), verdict: callsFor(AUTO_BACKGROUND, "verdict") };
  if (counts.analysis !== 1 || counts.verdict !== 1) throw new Error(`概览请求应该各发一次：${JSON.stringify(counts)}`);
  console.log("✓ 打开就出结论：后台打开的长视频切到前台才生成，卡片上出了结论，概览请求只发了一次");

  // 切走再切回来：不再生成。
  await evaluate(
    launcher,
    `chrome.tabs.query({ windowId: ${focused}, url: ${JSON.stringify(watchPage(AUTO_SHORT.id))} }).then(([tab]) => chrome.tabs.update(tab.id, { active: true })).then(() => chrome.tabs.update(${background}, { active: true })).then(() => true)`,
  );
  await quiet("切回来又发了模型请求", () => callsFor(AUTO_BACKGROUND, "analysis") + callsFor(AUTO_BACKGROUND, "verdict") > 2 || anyCallFor(AUTO_SHORT) || anyCallFor(AUTO_LONG));
  console.log("✓ 打开就出结论：同一个视频切走再切回来不再生成");

  // 关掉开关：在获得焦点的窗口前台打开长视频，卡片读完也不发模型请求。后面的步骤照旧是关着的。
  await writeSettings(undefined);
  await newTab(focused, AUTO_LONG, true);
  await until("前台的长视频播放页加载", async () => (await pages(AUTO_LONG)) === 2);
  await cardShows(AUTO_LONG, "生成概览");
  await quiet("开关关着时为长视频发模型请求", () => anyCallFor(AUTO_LONG));
  console.log("✓ 打开就出结论：开关关着时，前台打开长视频不发模型请求");
}
