// 端到端里的本窗口全部生成：在侧边栏所在的窗口里再开两个视频页，清点跳过已有概览的两个；确认后新生成的出结果，
// 生成中关掉侧边栏再打开，接上这一批，点「全部停止」停下在途的那个；失败或停掉的单条重试，最后收起。
// 要在侧边栏主流程之后跑：那时已登录、配好模型服务，侧边栏开着，窗口里有两个已经生成过概览的视频页。
import { videoKey } from "../src/core/video-ref.ts";
import { FOURTH_VIDEO, THIRD_VIDEO, VIDEOS } from "./fixtures.mjs";
import { watchPage } from "./mock-server.mjs";

/** 样例视频的编号：VIDEOS 里它的键。 */
const idOf = (video) => Object.keys(VIDEOS).find((id) => VIDEOS[id] === video) ?? "";

/**
 * @param {{ until: (label: string, read: () => unknown) => Promise<any>, evaluate: (session: string, expression: string, gesture?: boolean) => Promise<any>,
 *   cdp: { send: (method: string, params?: object, sessionId?: string) => Promise<any> },
 *   sessions: Map<string, { type: string, url: string, targetId?: string }>, launcher: string, panelUrl: string, mock: { models: { hold: (id: string) => void, release: (id: string) => void, held: (id: string) => number, calls: any[] } } }} deps
 */
export async function windowFlow({ until, evaluate, cdp, sessions, launcher, panelUrl, mock }) {
  const panels = () => [...sessions].filter(([sessionId, info]) => info.url === panelUrl && sessionId !== launcher && (info.type === "page" || info.type === "other")).map(([sessionId]) => sessionId);
  const known = new Set(panels());
  let panel = panels().at(-1);
  if (!panel) throw new Error("侧边栏没开着");
  const text = (selector) => evaluate(panel, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent).join("\\n")`);
  const click = (label, selector = ".batch-bar .button") =>
    until(`点「${label}」`, () =>
      evaluate(panel, `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((button) => button.textContent.trim().startsWith(${JSON.stringify(label)}) && !button.disabled); if (!node) return false; node.click(); return true; })()`),
    );
  const status = () => text(".batch-bar .batch-status");

  const third = idOf(THIRD_VIDEO);
  const fourth = idOf(FOURTH_VIDEO);
  const windowId = await evaluate(launcher, "chrome.tabs.getCurrent().then((tab) => tab.windowId)");
  // 侧边栏跟着当前标签页走：第三个视频页切到前台，概览页签才在。
  for (const [id, active] of [[third, true], [fourth, false]]) {
    await evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(watchPage(id))}, active: ${active} }).then(() => true)`);
  }
  // 第四个视频的概览请求挂住，等会儿在它生成中途停下。
  mock.models.hold(fourth);

  await until("切到概览页签", () => evaluate(panel, `(() => { const tab = document.querySelector("#tab-overview"); if (!tab) return false; tab.click(); return true; })()`));
  await click("本窗口全部生成");
  const counted = await until("清点完给出确认", async () => ((await status()).includes("要新生成") ? status() : null));
  // 窗口里还有前面播放页步骤和侧边栏主流程打开的两个视频页，它们都已经有概览。
  if (counted !== "本窗口有 4 个视频，跳过 2 个已有概览的，要新生成 2 个。") throw new Error(`确认提示不对：${counted}`);
  console.log(`✓ 本窗口全部生成：${counted}`);

  await click("开始生成 2 个");
  await until("新生成的第一个出结果、第二个挂在生成中", async () => (await status()).startsWith("本窗口：已完成 1 / 2") && mock.models.held(fourth) > 0);
  console.log("✓ 本窗口全部生成：跳过已有概览的，第一个新生成的出了结果");

  // 关掉侧边栏再打开：这一批不跟着页面走，重开时接上。
  // 侧边栏页面自己调 window.close() 就关掉面板；关掉以后求值等不到回复，不等它。
  void evaluate(panel, "window.close()").catch(() => {});
  const closedId = sessions.get(panel)?.targetId;
  await until("侧边栏关掉", async () => !(await cdp.send("Target.getTargets")).targetInfos.some((info) => info.targetId === closedId));
  await evaluate(launcher, `chrome.sidePanel.open({ windowId: ${windowId} }).then(() => true)`, true);
  panel = await until("侧边栏重新打开", () => panels().find((sessionId) => !known.has(sessionId)) ?? null);
  await until("重开后切到概览页签", () => evaluate(panel, `(() => { const tab = document.querySelector("#tab-overview"); if (!tab) return false; tab.click(); return true; })()`));
  await until("重开后接上这一批", async () => (await status()).startsWith("本窗口：已完成 1 / 2"));
  console.log("✓ 本窗口全部生成：关掉侧边栏再打开，接上了还在生成的这一批");

  await click("全部停止");
  await until("在途的那个停下", async () => (await status()).includes("已停止 1") && mock.models.held(fourth) === 0);
  if (!mock.models.calls.some((call) => call.video === fourth && call.kind === "analysis" && call.aborted)) throw new Error("全部停止后在途的模型请求没有断开");
  console.log("✓ 本窗口全部生成：生成中点「全部停止」，在途的请求断开");

  mock.models.release(fourth);
  await until("停掉的那条列在下面", async () => (await text(".batch-failure-title")).includes(FOURTH_VIDEO.title));
  await click("重试", ".batch-failure .button");
  await until("重试的那条出结果", async () => (await status()).startsWith("本窗口：已完成 2 / 2"));
  const overview = await evaluate(panel, `chrome.runtime.sendMessage({ type: "overview.get", req: { video: ${JSON.stringify(videoKey({ platform: "bilibili", videoId: fourth }))} } })`);
  if (!overview?.ok || !overview.value.overview?.analysis?.chapters?.length) throw new Error(`重试以后没有存下概览：${JSON.stringify(overview)}`);
  await click("收起");
  await until("收起以后回到按钮", async () => (await text(".batch-bar .button")).includes("本窗口全部生成"));
  console.log("✓ 本窗口全部生成：停掉的单条重试出了结果，收起");
}
