// 两家模拟的模型服务：Anthropic 和 OpenAI 的 Responses。按提示词里的视频标题认是哪个视频、按提示词认是概览块、结论、问答、整理字幕、
// 解释画面还是看图探测，
// 回一份能通过校验的结果。测试可以把某个视频的概览请求挂住，放行或客户端中途断开才收尾；每个请求都记下。
import { TUBE_VIDEOS } from "./youtube-page.mjs";
import { ANTHROPIC, OPENAI, SKIPPED_VIDEO, VIDEOS } from "./fixtures.mjs";

/** @typedef {import("./fixtures.mjs").ModelService} ModelService */
/** @typedef {import("node:http").IncomingMessage} Request */
/** @typedef {import("node:http").ServerResponse} Response */

/**
 * 一次模型请求。video 是视频的编号（fixtures 里 VIDEOS 的键），认不出时是空串。
 * @typedef {{ host: string, path: string, cookie: string, unexpected: boolean, at: number, answeredAt?: number, aborted?: true, abortedAt?: number,
 *   provider: string, kind: "analysis" | "verdict" | "qa" | "tidy" | "frame" | "probe" | "models" | "test" | "", video: string, held?: true, image?: true,
 *   frame?: { title: string, context: string } }} ModelCall
 * frame 是解释画面时提示词里的视频标题和前后字幕。
 */

const SERVICES = [
  { host: new URL(ANTHROPIC.origin).hostname, service: ANTHROPIC, protocol: "anthropic" },
  { host: new URL(OPENAI.origin).hostname, service: OPENAI, protocol: "responses" },
];

/** 两家模型服务的主机，映射到本机。 */
export const MODEL_HOSTS = Object.freeze(SERVICES.map(({ host }) => host));

/** @param {Request} req */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** 请求里的提示词全文：两家把系统提示词和对话放在不同的字段里。 @param {any} body */
function promptOf(body) {
  /** @type {string[]} */
  const parts = [];
  /** @param {unknown} content */
  const push = (content) => {
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) for (const block of content) push(block?.text ?? block?.content);
  };
  push(body?.system);
  push(body?.instructions);
  for (const message of [...(body?.messages ?? []), ...(Array.isArray(body?.input) ? body.input : [])]) push(message?.content);
  return parts.join("\n");
}

/** @param {string} prompt */
function videoOf(prompt) {
  const title = /^视频：(.+?)(?:（全长 [^）]*）)?$/m.exec(prompt)?.[1]?.trim();
  return [...Object.entries(VIDEOS), ...Object.entries(TUBE_VIDEOS)].find(([, video]) => video.title === title)?.[0] ?? "";
}

/** 回纯文本的几种请求。 @type {Readonly<Record<string, string>>} */
const PLAIN_REPLIES = { test: "可用", probe: "红色", frame: "模拟服务的画面解释：幻灯片上是一张受力分析图。" };

/** 设置页「测试连接」发的那句话。 */
const TEST_PROMPT = "回复两个字：可用";

/** @param {string} prompt @returns {"analysis" | "verdict" | "qa" | "tidy" | "frame" | "probe" | "test" | ""} */
function kindOf(prompt) {
  if (prompt.trim() === TEST_PROMPT) return "test";
  if (prompt.includes("这张小图是什么颜色")) return "probe";
  if (prompt.includes("这一帧的时间：")) return "frame";
  if (prompt.includes("你在整理视频字幕")) return "tidy";
  if (prompt.includes("用户的问题：")) return "qa";
  if (prompt.includes("各章：")) return "verdict";
  if (/本次范围：\d+:\d{2}/.test(prompt) && prompt.includes("这一段的字幕：")) return "analysis";
  return "";
}

/**
 * 概览块的章节和金句放在本块起点那一秒，结论按提示词的格式写（粗筛分组用的那个视频判可跳过），问答引用字幕第一句的时间点。
 * 整理字幕给每一条末尾补个句号。
 * @param {"analysis" | "verdict" | "qa" | "tidy"} kind @param {string} prompt
 */
function resultOf(kind, prompt) {
  if (kind === "tidy") {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('{"segments":[')));
    return { segments: input.segments.map((/** @type {{ id: string, text: string }} */ item) => ({ id: item.id, text: `${item.text}。` })) };
  }
  if (kind === "verdict") {
    // 重点章节标第一章：照提示词的要求抄它开头的时间点。标题译名一律给空串，侧边栏顶上照旧是原标题，测试按原标题认视频；显示译名的样子在页面测试里核对。
    const first = /^\[(\d+:\d{2})\]/m.exec(prompt)?.[1];
    return { summary: "模拟服务写的一句话结论", value: "样例价值", verdict: videoOf(prompt) === SKIPPED_VIDEO ? "可跳过" : "可以看", reason: "样例理由", keyChapters: first ? [first] : [], translatedTitle: "" };
  }
  if (kind === "qa") {
    const row = /^\[(\d+:\d{2})\] (.+)$/m.exec(prompt);
    return { answer: row ? `模拟服务的回答。【${row[1]}|${row[2]}】` : "" };
  }
  // 照提示词的要求抄本段开头的时间；金句里的秒数供端到端核对位置。
  const start = /本次范围：(\d+:\d{2})/.exec(prompt)?.[1] ?? "0:00";
  const [minutes = 0, rest = 0] = start.split(":").map(Number);
  const seconds = minutes * 60 + rest;
  return {
    chapters: [{ start, title: "模拟服务写的章节", summary: "样例摘要" }],
    keyQuotes: [{ start, quote: `模拟服务挑的金句（第 ${seconds} 秒）` }],
  };
}

/** @param {string} protocol @param {string} model @param {string} text @param {number} serial */
function completion(protocol, model, text, serial) {
  if (protocol === "anthropic") {
    return { id: `msg_e2e_${serial}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
  }
  return {
    id: `resp_e2e_${serial}`,
    object: "response",
    status: "completed",
    model,
    output: [{ type: "message", id: `msg_e2e_${serial}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

/** Anthropic 的模型列表带能力字段，请求按它决定结构化输出。 @param {string} protocol @param {string} model */
function modelList(protocol, model) {
  if (protocol !== "anthropic") return { object: "list", data: [{ id: model, object: "model", owned_by: "e2e" }] };
  const capabilities = {
    thinking: { supported: true, types: { disabled: { supported: true }, adaptive: { supported: true } } },
    effort: { supported: false },
    structured_outputs: { supported: true },
  };
  const entry = { type: "model", id: model, display_name: "模拟模型", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 32000, capabilities };
  return { data: [entry], has_more: false, first_id: model, last_id: model };
}

/** @param {ModelService} service @param {Request} req */
function authorized(service, req) {
  if (service === ANTHROPIC) return req.headers["x-api-key"] === service.key && Boolean(req.headers["anthropic-version"]);
  return req.headers.authorization === `Bearer ${service.key}`;
}

/** @param {{ record: (call: ModelCall) => void }} deps */
export function createModelServices({ record }) {
  /** @type {ModelCall[]} */
  const calls = [];
  /** 挂着的视频：它们的概览请求等放行。 */
  const holding = new Set();
  /** @type {Set<{ video: string, resolve: () => void }>} */
  const parked = new Set();
  let serial = 0;

  /** @param {Response} res @param {number} status @param {unknown} payload */
  function send(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  /** 挂住，等放行或客户端断开。交回客户端是不是已经断了。 @param {ModelCall} call @param {Response} res */
  async function park(call, res) {
    call.held = true;
    let closed = false;
    await new Promise((resolve) => {
      const item = { video: call.video, resolve: () => resolve(undefined) };
      parked.add(item);
      res.once("close", () => {
        closed = true;
        parked.delete(item);
        resolve(undefined);
      });
    });
    return closed;
  }

  return {
    calls,
    /** @param {string} host */
    serves: (host) => MODEL_HOSTS.includes(host),

    /** @param {Request} req @param {Response} res @param {{ host: string, path: string }} where */
    async handle(req, res, { host, path }) {
      const found = SERVICES.find((item) => item.host === host);
      /** @type {ModelCall} */
      const call = { host, path, cookie: String(req.headers.cookie ?? ""), unexpected: false, at: Date.now(), provider: found?.protocol ?? "", kind: "", video: "" };
      calls.push(call);
      record(call);
      const raw = await readBody(req);
      if (!found || !authorized(found.service, req)) {
        call.unexpected = true;
        return send(res, 401, { error: { message: "sample refusal" } });
      }
      const { protocol, service } = found;
      if (req.method === "GET" && path === "/v1/models") {
        call.kind = "models";
        send(res, 200, modelList(protocol, service.model));
        call.answeredAt = Date.now();
        return undefined;
      }
      const endpoint = protocol === "anthropic" ? "/v1/messages" : "/v1/responses";
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const prompt = promptOf(body);
      call.kind = kindOf(prompt);
      call.video = videoOf(prompt);
      // 带图的请求记一笔：两家的图片块写法不同。
      if (/"type":"(?:image|input_image)"/.test(raw)) call.image = true;
      if (call.kind === "frame") call.frame = { title: /^视频：(.*)$/m.exec(prompt)?.[1]?.trim() ?? "", context: /这一刻前后的字幕：\n([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? "" };
      // 测试连接和看图探测不带视频；YouTube 上没读过字幕时解释画面的标题取自标签页，不一定认得出是哪个视频。其余请求要认得出。
      if (req.method !== "POST" || path !== endpoint || !call.kind || (!call.video && !["test", "probe", "frame"].includes(call.kind))) {
        call.unexpected = true;
        return send(res, 404, { error: { message: "sample refusal" } });
      }
      if (call.kind === "analysis" && holding.has(call.video) && (await park(call, res))) {
        call.aborted = true;
        call.abortedAt = Date.now();
        return undefined;
      }
      serial += 1;
      const text = PLAIN_REPLIES[call.kind] ?? JSON.stringify(resultOf(/** @type {"analysis" | "verdict" | "qa" | "tidy"} */ (call.kind), prompt));
      send(res, 200, completion(protocol, body?.model ?? service.model, text, serial));
      call.answeredAt = Date.now();
      return undefined;
    },

    /** 之后这个视频的概览请求都挂住。 @param {string} video */
    hold(video) {
      holding.add(video);
    },

    /** 不再挂这个视频，已经挂着的马上回。 @param {string} video */
    release(video) {
      holding.delete(video);
      for (const item of [...parked]) {
        if (item.video !== video) continue;
        parked.delete(item);
        item.resolve();
      }
    },

    /** 这个视频现在挂着几个请求。 @param {string} video */
    held: (video) => [...parked].filter((item) => item.video === video).length,

    close() {
      holding.clear();
      for (const item of parked) item.resolve();
      parked.clear();
    },
  };
}
