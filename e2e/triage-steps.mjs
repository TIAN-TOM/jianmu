// 端到端里的稍后再看粗筛：从设置页打开粗筛页，读列表；第一步取官方总结，两次请求至少隔 1.5 秒，本机缓存里有的不再问；
// 第二步只发模型请求、不向平台读；按判断分组、筛选，导出的 Markdown 按组列出。要在登录、配好模型服务之后跑。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_VIDEO, FOURTH_VIDEO, SECOND_VIDEO, SKIPPED_VIDEO, THIRD_VIDEO, VIDEOS } from "./fixtures.mjs";
import { officialRead, watchLaterRead } from "./mock-server.mjs";

const LISTED = [FIRST_VIDEO, SECOND_VIDEO, THIRD_VIDEO, FOURTH_VIDEO];
/** 样例视频的编号：VIDEOS 里它的键。 */
const idOf = (video) => Object.keys(VIDEOS).find((id) => VIDEOS[id] === video) ?? "";

/**
 * @param {{ until: (label: string, read: () => unknown) => Promise<any>, evaluate: (session: string, expression: string, gesture?: boolean) => Promise<any>,
 *   cdp: { send: (method: string, params?: object, sessionId?: string) => Promise<any> }, findSession: (type: string, url: string) => string | null,
 *   mock: { requests: any[] }, extensionId: string, downloads: string }} deps
 */
export async function triageFlow({ until, evaluate, cdp, findSession, mock, extensionId, downloads }) {
  const optionsUrl = `chrome-extension://${extensionId}/pages/options.html`;
  const triageUrl = `chrome-extension://${extensionId}/pages/triage.html`;
  await cdp.send("Target.createTarget", { url: optionsUrl });
  const options = await until("设置页打开", () => findSession("page", optionsUrl));
  await until("设置页的粗筛入口", () => evaluate(options, `(() => { const link = document.getElementById("openTriage"); if (!link) return false; link.click(); return true; })()`, true));
  const page = await until("点入口后打开粗筛页", () => findSession("page", triageUrl));
  const text = (selector) => evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
  const click = (label) =>
    until(`点「${label}」`, () =>
      evaluate(page, `(() => { const node = [...document.querySelectorAll("button")].find((button) => button.textContent.trim().startsWith(${JSON.stringify(label)}) && !button.disabled); if (!node) return false; node.click(); return true; })()`),
    );
  const rows = () => evaluate(page, `[...document.querySelectorAll(".video")].map((row) => ({ text: row.innerText, group: row.dataset.group }))`);
  const rowOf = (list, video) => list.find((row) => row.text.includes(video.title));

  const listReads = mock.requests.filter(watchLaterRead).length;
  await click("读取我的稍后再看");
  await until("列出稍后再看", async () => (await rows()).length === LISTED.length);
  if (mock.requests.filter(watchLaterRead).length !== listReads + 1) throw new Error("读列表应该只问一次平台");
  console.log(`✓ 粗筛：从设置页打开粗筛页，读到稍后再看的 ${LISTED.length} 个视频`);

  const beforeOfficial = mock.requests.length;
  await click("开始取官方总结");
  await click("现在开始");
  await until("第一步取完", async () => (await text("#step-official .status")).includes("这一轮取完了"));
  const summaries = mock.requests.slice(beforeOfficial).filter(officialRead);
  const asked = summaries.map((entry) => entry.video);
  // 前面的步骤读过前两个视频，官方总结已经在本机缓存里。
  if (asked.join() !== [idOf(THIRD_VIDEO), idOf(FOURTH_VIDEO)].join()) throw new Error(`第一步问了 ${asked.join("、") || "（无）"}，应只问本机没有的两个`);
  const gaps = summaries.slice(1).map((entry, index) => entry.at - summaries[index].at);
  if (gaps.some((gap) => gap < 1500)) throw new Error(`两次官方总结请求的间隔不足 1.5 秒：${gaps.join("、")} ms`);
  const fetched = await rows();
  if (!/没有官方总结/.test(rowOf(fetched, FOURTH_VIDEO)?.text ?? "")) throw new Error("没有官方总结的那个视频没标出来");
  console.log(`✓ 粗筛第一步：只问本机没有的 ${asked.length} 个，两次请求隔了 ${gaps.join("、")} ms`);

  const beforeVerdict = mock.requests.length;
  await click("开始写结论");
  const confirm = await until("第二步的确认", () => text(".confirm"));
  // 前两个视频之前生成过概览，已经有结论。
  if (!confirm.includes("要给 1 个有官方总结的视频写一句话结论") || !confirm.includes("已经有结论的 2 个会跳过")) throw new Error(`第二步的确认不对：${confirm}`);
  await click("现在开始");
  await until("第二步写完", async () => (await text("#step-verdict .status")).includes("这一轮写完了，写好 1 个"));
  const during = mock.requests.slice(beforeVerdict);
  const site = during.filter((entry) => !entry.provider);
  if (site.length) throw new Error(`第二步向平台发了请求：${site.map((entry) => entry.path).join("、")}`);
  const verdicts = during.filter((entry) => entry.provider && entry.kind === "verdict").map((entry) => entry.video);
  if (verdicts.join() !== SKIPPED_VIDEO) throw new Error(`第二步的模型请求不对：${JSON.stringify(during.map(({ kind, video }) => ({ kind, video })))}`);
  console.log("✓ 粗筛第二步：只发了一次模型请求写结论，没向平台读");

  const grouped = await until("分好组", async () => {
    const list = await rows();
    return rowOf(list, THIRD_VIDEO)?.group === "skip" ? list : null;
  });
  const groups = LISTED.map((video) => rowOf(grouped, video)?.group);
  const expected = ["overview", "overview", "skip", "pending"];
  if (JSON.stringify(groups) !== JSON.stringify(expected)) throw new Error(`分组不对：${JSON.stringify(groups)}`);
  await click("可以跳过");
  await until("筛选后只剩可以跳过的", async () => {
    const list = await rows();
    return list.length === 1 && list[0].text.includes(THIRD_VIDEO.title);
  });

  await click("导出 Markdown");
  const file = await until("导出的 Markdown 下载下来", () => readdirSync(downloads).find((name) => name.endsWith(".md")) ?? null);
  const markdown = readFileSync(join(downloads, file), "utf8");
  const sections = Object.fromEntries(markdown.split(/^## /m).slice(1).map((block) => [block.split("\n")[0], block]));
  const expectSection = (heading, videos) => {
    const block = sections[heading];
    if (!block || videos.some((video) => !block.includes(video.title))) throw new Error(`导出的「${heading}」不对：${block ?? "没有这一组"}`);
  };
  expectSection("看概览就够（2）", [FIRST_VIDEO, SECOND_VIDEO]);
  expectSection("可以跳过（1）", [THIRD_VIDEO]);
  expectSection("还没判断（1）", [FOURTH_VIDEO]);
  console.log("✓ 粗筛：按判断分组、筛选，导出的 Markdown 按组列出");
}
