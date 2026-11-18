// 端到端里的打开就出结论：另开一个获得焦点的窗口。打开开关（门槛调到 20 分钟）以后，不到门槛的短视频不生成；
// 后台打开的长视频不用切过去就开始生成；它在跑时，没有焦点的窗口里的长视频排着、不发请求；排着时关掉的标签页撤掉、
// 不读也不发；前一个收尾后排着的接着生成；切到后台生成好的那个，卡片直接显示结论、不再发请求；切走再切回来不再发。
// 关掉开关以后在前台打开长视频，不发模型请求。最后再打开开关、让平台限流：读到限流就整批停下，同时开的另一个不再去读。
// 要在侧边栏主流程之后跑：那时已登录、配好模型服务。
import { AUTO_SAMPLES, ANTHROPIC } from "./fixtures.mjs";
import { watchPage } from "./mock-server.mjs";
import { storedSettings } from "./settings.mjs";

const { long: AUTO_LONG, short: AUTO_SHORT, background: AUTO_BACKGROUND, queued: AUTO_QUEUED, limitedA: LIMITED_A, limitedB: LIMITED_B } = AUTO_SAMPLES;

/** 确认某件事没发生要看多久。 */
const QUIET_MS = 2000;

/**
 * @param {{ until: (label: string, read: () => unknown) => Promise<any>, evaluate: (session: string, expression: string) => Promise<any>,
 *   cdp: { send: (method: string, params?: object, sessionId?: string) => Promise<any> }, launcher: string,
 *   mock: { models: { calls: { video: string, kind: string }[], hold: (video: string) => void, release: (video: string) => void, held: (video: string) => number },
 *     requests: { video: string }[], setScenario: (name: string) => void } }} deps
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

  const siteReadFor = (video) => mock.requests.some((entry) => entry.video === video.id);

  // 后台打开的长视频：不用切过去就开始生成。先挂住它的概览请求，让它一直在跑。
  mock.models.hold(AUTO_BACKGROUND.id);
  const background = await newTab(focused, AUTO_BACKGROUND, false);
  await until("后台打开的长视频开始生成", () => mock.models.held(AUTO_BACKGROUND.id) > 0);
  console.log("✓ 打开就出结论：后台打开的长视频不用切过去就开始生成");

  // 它在跑时：没有焦点的窗口里的长视频排着，不发请求；排着时关掉的标签页撤掉。
  await evaluate(launcher, `chrome.windows.create({ url: ${JSON.stringify(watchPage(AUTO_LONG.id))}, focused: false }).then(() => true)`);
  await until("没有焦点的窗口里的播放页加载", async () => (await pages(AUTO_LONG)) === 1);
  const queued = await newTab(focused, AUTO_QUEUED, false);
  await until("排着的播放页加载", async () => (await pages(AUTO_QUEUED)) === 1);
  await quiet("同时生成了第二个", () => anyCallFor(AUTO_LONG) || anyCallFor(AUTO_QUEUED));
  await evaluate(launcher, `chrome.tabs.remove(${queued}).then(() => true)`);
  await until("排着的标签页关掉", async () => (await pages(AUTO_QUEUED)) === 0);
  console.log("✓ 打开就出结论：同时只生成一个，别的排着不发请求");

  // 前一个收尾：排着的那个接着生成；关掉的那个不读也不发。
  mock.models.release(AUTO_BACKGROUND.id);
  await until("排着的长视频接着生成完", () => callsFor(AUTO_LONG, "verdict") === 1);
  await quiet("关掉的标签页还被读取或生成", () => anyCallFor(AUTO_QUEUED) || siteReadFor(AUTO_QUEUED));
  console.log("✓ 打开就出结论：前一个收尾后排着的接着生成，排着时关掉的撤掉了，不读也不发");

  // 切到后台生成好的那个：卡片直接显示结论，概览请求各只发过一次。
  await evaluate(launcher, `chrome.tabs.update(${background}, { active: true }).then(() => true)`);
  await cardShows(AUTO_BACKGROUND, "模拟服务写的一句话结论");
  for (const video of [AUTO_BACKGROUND, AUTO_LONG]) {
    const counts = { analysis: callsFor(video, "analysis"), verdict: callsFor(video, "verdict") };
    if (counts.analysis !== 1 || counts.verdict !== 1) throw new Error(`「${video.title}」的概览请求应该各发一次：${JSON.stringify(counts)}`);
  }
  console.log("✓ 打开就出结论：切到后台生成好的那个，卡片上直接是结论，概览请求只发了一次");

  // 切走再切回来：不再生成。
  await evaluate(
    launcher,
    `chrome.tabs.query({ windowId: ${focused}, url: ${JSON.stringify(watchPage(AUTO_SHORT.id))} }).then(([tab]) => chrome.tabs.update(tab.id, { active: true })).then(() => chrome.tabs.update(${background}, { active: true })).then(() => true)`,
  );
  await quiet("切回来又发了模型请求", () => callsFor(AUTO_BACKGROUND, "analysis") + callsFor(AUTO_BACKGROUND, "verdict") > 2 || anyCallFor(AUTO_SHORT));
  console.log("✓ 打开就出结论：同一个视频切走再切回来不再生成");

  // 关掉开关：在获得焦点的窗口前台打开长视频，卡片读完也不发模型请求。后面的步骤照旧是关着的。
  await writeSettings(undefined);
  const offTab = await newTab(focused, LIMITED_A, true);
  await until("前台的长视频播放页加载", async () => (await pages(LIMITED_A)) === 1);
  await cardShows(LIMITED_A, "生成概览");
  await quiet("开关关着时为长视频发模型请求", () => anyCallFor(LIMITED_A));
  await evaluate(launcher, `chrome.tabs.remove(${offTab}).then(() => true)`);
  console.log("✓ 打开就出结论：开关关着时，前台打开长视频不发模型请求");

  // 再打开开关、让平台限流，在后台同时开两个长视频：读到限流就整批停下，另一个不再去读，谁都不发模型请求。
  mock.setScenario("code-limited");
  await writeSettings({ minutes: 20 });
  const before = mock.requests.length;
  const readsOf = (video) => mock.requests.slice(before).filter((entry) => entry.video === video.id).length;
  const limited = [await newTab(focused, LIMITED_A, false), await newTab(focused, LIMITED_B, false)];
  await until("两个播放页加载", async () => (await pages(LIMITED_A)) === 1 && (await pages(LIMITED_B)) === 1);
  await until("先打开的那个去读平台、被限流", () => readsOf(LIMITED_A) > 0);
  await quiet("被限流以后还在接着读", () => readsOf(LIMITED_B) > 0 || readsOf(LIMITED_A) > 2);
  await quiet("被限流时发了模型请求", () => anyCallFor(LIMITED_A) || anyCallFor(LIMITED_B));
  mock.setScenario("");
  await writeSettings(undefined);
  for (const tab of limited) await evaluate(launcher, `chrome.tabs.remove(${tab}).then(() => true)`);
  console.log("✓ 打开就出结论：读平台被限流就整批停下，同时开的另一个不再去读");
}
