// 设置的结构和规则：地址校验和端点、预设、规整、校验、按功能选模型、密钥和来源的绑定、启用确认。
// 地址相关的用例都走实际拼地址的 chatCompletionsUrl、modelsUrl，确认设置和请求用的是同一张预设表。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_OVERLAP_CHARS } from "../../../src/core/ai/chunking.ts";
import {
  chatCompletionsUrl,
  ENDPOINT_PRESETS,
  modelsUrl,
  PROTOCOLS,
  validateBaseUrl,
  type Protocol,
} from "../../../src/core/ai/provider/endpoint.ts";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
  DATA_CONSENT_ERROR,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_VERSION,
} from "../../../src/core/consent.ts";
import * as SETTINGS from "../../../src/shared/settings-schema.ts";

const HTTPS_ERROR = "API 地址要以 https:// 开头，本机地址也不能用 http://。";
const KEY_ERROR = "请填写 API 密钥（浏览器重启、扩展更新后要重新填）。";
const MODEL_ERROR = "请填写模型名称，或点击「拉取模型列表」进行选择。";
const STALE_FINGERPRINT = "0000000000000000";
const OPENAI_KEY = "sk-openai-secret";

// 确认过数据说明。只想测别的校验项的用例带上它。
const CONSENTED = SETTINGS.DATA_CONSENT_CONFIRMED;

// 只有「自定义」才认外部传入的地址与协议。想单独验端点拼接的用例，得先声明自己是自定义配置。
const custom = (overrides: SETTINGS.SettingsInput): SETTINGS.SettingsInput => ({
  presetId: SETTINGS.CUSTOM_PRESET_ID,
  ...overrides,
});

const urlOf = (input: unknown, protocol?: Protocol): string => {
  const check = validateBaseUrl(input, protocol);
  assert.equal(check.ok, true, String(input));
  return check.ok ? check.url : "";
};

const errorOf = (input: unknown, protocol?: Protocol): string => {
  const check = validateBaseUrl(input, protocol);
  assert.equal(check.ok, false, String(input));
  return check.ok ? "" : check.error;
};

// ============================================================
// 地址校验
// ============================================================

test("接受 https 地址并去掉尾部斜杠", () => {
  assert.deepEqual(validateBaseUrl("https://api.deepseek.com/"), {
    ok: true,
    url: "https://api.deepseek.com",
    origin: "https://api.deepseek.com/",
  });
});

test("保留路径中的版本号", () => {
  assert.equal(urlOf("https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(
    urlOf("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
});

test("粘进来的完整端点会被还原成 base", () => {
  assert.equal(urlOf("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1");
  assert.equal(urlOf("https://api.anthropic.com/v1/messages", PROTOCOLS.ANTHROPIC), "https://api.anthropic.com");
});

test("Anthropic 协议下 base 里多余的 /v1 会被去掉，避免拼成 /v1/v1/messages", () => {
  assert.equal(urlOf("https://api.anthropic.com/v1", PROTOCOLS.ANTHROPIC), "https://api.anthropic.com");
  assert.equal(
    chatCompletionsUrl(custom({ protocol: PROTOCOLS.ANTHROPIC, aiBaseUrl: "https://api.anthropic.com/v1", aiModel: "m" })),
    "https://api.anthropic.com/v1/messages",
  );
});

test("地址只认 https：明文 http 一律拦下，本机回环地址也不例外", () => {
  for (const http of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000/v1",
    "http://api.example.com/v1",
    "http://192.168.1.50:8000/v1",
    "http://0.0.0.0:11434/v1",
    "http://localhost.example.com/v1",
  ]) {
    assert.equal(errorOf(http), HTTPS_ERROR, http);
    // 设置里存着这样的地址时拼不出请求地址，发不出去，也不为它申请权限。
    const stored = custom({ aiBaseUrl: http, aiApiKey: "k", aiModel: "m", ...CONSENTED });
    assert.equal(chatCompletionsUrl(stored), null, http);
    assert.equal(modelsUrl(stored), null, http);
    assert.equal(SETTINGS.originOf(http), null, http);
    assert.deepEqual(SETTINGS.validate(stored).errors, [HTTPS_ERROR], http);
  }
  // https 的本机地址按统一规则处理，不另设识别本机的规则。
  assert.deepEqual(validateBaseUrl("https://localhost:8443/v1"), {
    ok: true,
    url: "https://localhost:8443/v1",
    origin: "https://localhost:8443/",
  });

  // Chrome 权限系统申请不到 IPv6 字面量，仍然拦下。
  assert.equal(validateBaseUrl("https://[::1]:11434/v1").ok, false);
  assert.match(errorOf("https://[2001:db8::1]/v1"), /IPv6/);
});

test("拒绝非 http(s) 协议与非法 URL", () => {
  for (const bad of ["ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "not a url", ""]) {
    assert.equal(validateBaseUrl(bad).ok, false, `不该接受：${bad}`);
  }
});

test("originOf 产出可直接用于权限申请的来源", () => {
  assert.equal(SETTINGS.originOf("https://api.openai.com/v1"), "https://api.openai.com/");
  assert.equal(SETTINGS.originOf("http://localhost:11434/v1"), null, "http 地址不申请权限");
  assert.equal(SETTINGS.originOf("不是地址"), null);
});

// ============================================================
// 端点拼接
// ============================================================

test("两种协议拼出各自的对话端点", () => {
  assert.equal(
    chatCompletionsUrl(custom({ protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://api.deepseek.com", aiModel: "m" })),
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl(custom({ protocol: PROTOCOLS.ANTHROPIC, aiBaseUrl: "https://api.anthropic.com", aiModel: "m" })),
    "https://api.anthropic.com/v1/messages",
  );
});

test("两种协议拼出各自的模型列表端点", () => {
  assert.equal(
    modelsUrl(custom({ protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://api.openai.com/v1", aiModel: "m" })),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    modelsUrl(custom({ protocol: PROTOCOLS.ANTHROPIC, aiBaseUrl: "https://api.anthropic.com", aiModel: "m" })),
    "https://api.anthropic.com/v1/models",
  );
});

test("地址非法时端点返回 null 而不是拼出一个坏 URL", () => {
  assert.equal(chatCompletionsUrl(custom({ aiBaseUrl: "ftp://evil.example.com" })), null);
});

// ============================================================
// 规整
// ============================================================

test("新安装默认用 Anthropic Claude 和 claude-sonnet-5-5", () => {
  const normalized = SETTINGS.normalize({});
  assert.equal(normalized.presetId, "anthropic");
  assert.equal(normalized.protocol, PROTOCOLS.ANTHROPIC);
  assert.equal(normalized.aiBaseUrl, "https://api.anthropic.com");
  assert.equal(normalized.aiModel, "claude-sonnet-5-5");
  assert.equal(chatCompletionsUrl(normalized), "https://api.anthropic.com/v1/messages");
});

test("存着 DeepSeek 的配置读出来仍是 DeepSeek，密钥照旧", () => {
  const normalized = SETTINGS.normalize({
    presetId: "deepseek",
    aiApiKey: "sk-deepseek-1234",
    aiApiKeyOrigin: "https://api.deepseek.com/",
    aiModel: "",
  });
  assert.equal(normalized.presetId, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiApiKey, "sk-deepseek-1234");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  // 存着 Anthropic、模型自己填过的，模型不被默认值顶掉。
  assert.equal(SETTINGS.normalize({ presetId: "anthropic", aiModel: "claude-haiku-4-5" }).aiModel, "claude-haiku-4-5");
});

const MAINLAND_PRESETS: Readonly<Record<string, string>> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  moonshot: "https://api.moonshot.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
};

test("这五家走 OpenAI 兼容协议和 https 大陆端点，不带默认模型，有密钥页链接", () => {
  for (const [presetId, baseUrl] of Object.entries(MAINLAND_PRESETS)) {
    const preset = SETTINGS.presetById(presetId);
    assert.equal(preset?.protocol, PROTOCOLS.OPENAI, presetId);
    assert.equal(preset?.baseUrl, baseUrl, presetId);
    assert.equal(preset?.model, "", presetId);
    assert.match(preset?.docsUrl ?? "", /^https:\/\//, presetId);
    assert.equal(chatCompletionsUrl(SETTINGS.normalize({ presetId })), `${baseUrl}/chat/completions`, presetId);
    assert.equal(modelsUrl(SETTINGS.normalize({ presetId })), `${baseUrl}/models`, presetId);
    // 没选模型就发不出请求，也不拿列表第一个凑数。
    const ready = SETTINGS.validate({ presetId, aiApiKey: "sk-test", ...CONSENTED });
    assert.equal(ready.ok, false, presetId);
    assert.deepEqual(ready.errors, [MODEL_ERROR], presetId);
    assert.equal(SETTINGS.validate({ presetId, aiApiKey: "sk-test", aiModel: "m", ...CONSENTED }).ok, true, presetId);
  }
});

test("存着这五家的配置原样读出：服务商、模型、密钥和按功能选的模型都还在", () => {
  for (const [presetId, baseUrl] of Object.entries(MAINLAND_PRESETS)) {
    const origin = `${new URL(baseUrl).origin}/`;
    const stored = {
      presetId,
      protocol: PROTOCOLS.OPENAI,
      aiBaseUrl: baseUrl,
      aiApiKey: `sk-${presetId}-secret`,
      aiApiKeyOrigin: origin,
      aiModel: `${presetId}-large`,
      featureModels: { verdict: `${presetId}-small`, explain: `${presetId}-mini` },
      featureModelsOwner: `${presetId}|${origin}`,
      ...CONSENTED,
    };
    const normalized = SETTINGS.normalize(stored);
    assert.equal(normalized.presetId, presetId);
    assert.equal(normalized.protocol, PROTOCOLS.OPENAI, presetId);
    assert.equal(normalized.aiBaseUrl, baseUrl, presetId);
    assert.equal(normalized.aiModel, `${presetId}-large`, presetId);
    assert.equal(normalized.aiApiKey, `sk-${presetId}-secret`, presetId);
    assert.equal(normalized.aiApiKeyOrigin, origin, presetId);
    assert.deepEqual(normalized.featureModels, { verdict: `${presetId}-small`, explain: `${presetId}-mini` }, presetId);
    assert.equal(normalized.featureModelsOwner, `${presetId}|${origin}`, presetId);
    assert.equal(SETTINGS.validate(stored).ok, true, presetId);
    assert.deepEqual(SETTINGS.normalize(normalized), normalized, presetId);
  }
});

test("这五家按预设的地址走：存储里残留的别的地址和协议不算数", () => {
  const stored = {
    presetId: "moonshot",
    aiBaseUrl: "https://stale.example.com/v1",
    protocol: PROTOCOLS.ANTHROPIC,
    aiApiKey: "sk-moonshot",
    aiApiKeyOrigin: "https://api.moonshot.cn/",
  };
  const normalized = SETTINGS.normalize(stored);
  assert.equal(normalized.aiBaseUrl, "https://api.moonshot.cn/v1");
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(normalized.aiApiKey, "sk-moonshot");
  // 没经过规整的设置也一样，拼地址时同样让位给预设。
  assert.equal(chatCompletionsUrl(stored), "https://api.moonshot.cn/v1/chat/completions");
  assert.equal(modelsUrl(stored), "https://api.moonshot.cn/v1/models");
});

test("自定义服务的地址与模型原样保留", () => {
  const normalized = SETTINGS.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.OPENAI,
    aiApiKey: "  sk-test  ",
    aiBaseUrl: "  https://my-proxy.example.com/v1/  ",
    aiModel: "  my-model  ",
  });
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(normalized.aiApiKey, "sk-test");
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com/v1");
  assert.equal(normalized.aiModel, "my-model");
});

test("Anthropic 兼容代理：剥掉 /v1 再拼回去，最终端点不变", () => {
  // 存的是剥掉 /v1 的形式，但用户填的和最终请求的地址是一致的，
  // 所以这个规整对用户不可见，除非它把两头搞反，那就会拼出 /v1/v1/messages。
  const normalized = SETTINGS.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.ANTHROPIC,
    aiApiKey: "k",
    aiBaseUrl: "https://my-proxy.example.com/v1",
    aiModel: "m",
  });
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com");
  assert.equal(chatCompletionsUrl(normalized), "https://my-proxy.example.com/v1/messages");
});

test("选了具体厂商时，存着的地址与协议一律让位给预设", () => {
  // 设置页把这两栏藏了起来，输入框里很可能还留着上次自定义的值。
  // 如果存着的值能盖过预设，用户就会拿着 A 家的密钥去打 B 家的接口。
  const stored = {
    presetId: "deepseek",
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://leftover-proxy.example.com/v1",
    aiApiKey: "sk-test",
    aiModel: "deepseek-v4-flash",
  };
  const normalized = SETTINGS.normalize(stored);
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(chatCompletionsUrl(normalized), "https://api.deepseek.com/chat/completions");
  assert.equal(chatCompletionsUrl(stored), "https://api.deepseek.com/chat/completions");
});

test("存着带路径的地址时，仍然按预设的地址走", () => {
  const anthropic = SETTINGS.normalize({
    presetId: "anthropic",
    aiBaseUrl: "https://api.anthropic.com/v1/messages",
    aiApiKey: "k",
    aiModel: "m",
  });
  assert.equal(anthropic.aiBaseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.protocol, PROTOCOLS.ANTHROPIC);
});

test("只有「自定义」才认用户填的地址与协议", () => {
  const normalized = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://my-proxy.example.com",
    aiApiKey: "k",
    aiModel: "m",
  });
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com");
  assert.equal(normalized.protocol, PROTOCOLS.ANTHROPIC);
});

test("自定义时不填地址会落到空值，由 validate 报错而不是静默用 DeepSeek", () => {
  const normalized = SETTINGS.normalize({ presetId: SETTINGS.CUSTOM_PRESET_ID, aiApiKey: "k", aiModel: "m" });
  assert.equal(normalized.aiBaseUrl, "");
  assert.equal(SETTINGS.validate(normalized).ok, false);
});

test("换预设时模型回落到该预设的默认值", () => {
  assert.equal(SETTINGS.normalize({ presetId: "deepseek" }).aiModel, "deepseek-v4-flash");
  // 其余预设没有默认模型，留空让用户去拉取。
  assert.equal(SETTINGS.normalize({ presetId: "openai" }).aiModel, "");
});

test("未知的协议或预设回落到默认值", () => {
  const stored = { presetId: "不存在的服务商", protocol: "不存在的协议" };
  const normalized = SETTINGS.normalize(stored);
  assert.equal(normalized.presetId, "anthropic");
  assert.equal(normalized.protocol, PROTOCOLS.ANTHROPIC);
  assert.equal(chatCompletionsUrl(stored), "https://api.anthropic.com/v1/messages");
  assert.equal(modelsUrl(stored), "https://api.anthropic.com/v1/models");
});

test("非法地址原样保留，交给设置页报错，而不是悄悄改回默认值", () => {
  const normalized = SETTINGS.normalize({ presetId: "custom", aiBaseUrl: "ftp://api.example.com" });
  assert.equal(normalized.aiBaseUrl, "ftp://api.example.com");
  assert.equal(SETTINGS.validate(normalized).ok, false);
});

test("normalize 能接受 null 与非对象输入", () => {
  assert.equal(SETTINGS.normalize(null).presetId, "anthropic");
  assert.equal(SETTINGS.normalize("字符串").presetId, "anthropic");
  assert.equal(SETTINGS.normalize(undefined).aiApiKey, "");
});

// ============================================================
// 配置校验
// ============================================================

test("远程服务缺密钥或缺模型都算没配好", () => {
  const noKey = SETTINGS.validate({ presetId: "custom", aiBaseUrl: "https://api.example.com/v1", aiModel: "m" });
  assert.equal(noKey.ok, false);
  assert.match(noKey.errors.join(""), /密钥/);

  const noModel = SETTINGS.validate({ presetId: "custom", aiBaseUrl: "https://api.example.com/v1", aiApiKey: "k" });
  assert.equal(noModel.ok, false);
  assert.match(noModel.errors.join(""), /模型/);
});

test("没确认数据说明时不通过校验，确认的是旧版本也不行", () => {
  const configured = { presetId: "deepseek", aiApiKey: "sk-test", aiModel: "deepseek-v4-flash" };
  assert.deepEqual(SETTINGS.validate(configured).errors, [DATA_CONSENT_ERROR]);
  assert.deepEqual(
    SETTINGS.validate({ ...configured, ...CONSENTED, dataConsentVersion: DATA_CONSENT_VERSION - 1 }).errors,
    [DATA_CONSENT_ERROR],
  );
  // 版本对得上、指纹对不上或没存，同样按没确认处理。
  assert.deepEqual(
    SETTINGS.validate({ ...configured, ...CONSENTED, dataConsentFingerprint: STALE_FINGERPRINT }).errors,
    [DATA_CONSENT_ERROR],
  );
  assert.deepEqual(SETTINGS.validate({ ...configured, dataConsentVersion: DATA_CONSENT_VERSION }).errors, [
    DATA_CONSENT_ERROR,
  ]);
  assert.deepEqual(SETTINGS.validate({ ...configured, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT }).errors, [
    DATA_CONSENT_ERROR,
  ]);
  assert.equal(SETTINGS.validate({ ...configured, ...CONSENTED }).ok, true);
  for (const bad of ["1", 1.5, -1, null, true]) {
    assert.equal(SETTINGS.normalize({ dataConsentVersion: bad }).dataConsentVersion, 0, String(bad));
  }
  assert.equal(SETTINGS.normalize({ dataConsentFingerprint: 7 }).dataConsentFingerprint, "");
  assert.equal(SETTINGS.normalize({}).dataConsentVersion, 0, "新安装默认没确认");
});

test("配置齐全时通过校验", () => {
  const ok = SETTINGS.validate({
    presetId: "deepseek",
    aiApiKey: "sk-test",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    ...CONSENTED,
  });
  assert.equal(ok.ok, true, ok.errors.join(" "));
});

// ============================================================
// 外观和分块
// ============================================================

test("界面字号三档：标准 100、较大 112、特大 125，其他数值就近归档", () => {
  assert.deepEqual(SETTINGS.UI_FONT_SCALES, [100, 112, 125]);
  assert.equal(SETTINGS.normalize({}).uiFontScale, 100);
  const cases = [
    [80, 100], [90, 100], [100, 100], [105, 100],
    // 正好在两档中间时取大的一档。
    [106, 112], [110, 112], [112, 112], [115, 112], [118, 112],
    [119, 125], [120, 125], [125, 125], [130, 125], [160, 125], [999, 125],
    [10, 100], [0, 100], [-20, 100],
    ["112", 112], ["130", 125], [112.4, 112],
  ] as const;
  for (const [stored, tier] of cases) {
    assert.equal(SETTINGS.normalize({ uiFontScale: stored }).uiFontScale, tier, `存的是 ${stored}`);
    assert.equal(SETTINGS.normalizeUiFontScale(stored), tier, `直接给 ${stored}`);
  }
  for (const bad of ["abc", Number.NaN, null, "", {}, [], true]) {
    assert.equal(SETTINGS.normalize({ uiFontScale: bad }).uiFontScale, 100, JSON.stringify(bad));
  }
  // 归好档的值存回去再读一遍不变。
  for (const tier of SETTINGS.UI_FONT_SCALES) {
    assert.equal(SETTINGS.normalize({ uiFontScale: tier }).uiFontScale, tier);
  }
});

test("概览分块模式默认自动，并只接受自动、较短、较长三种值", () => {
  assert.equal(SETTINGS.normalize({}).analysisChunkMode, "auto");
  assert.equal(SETTINGS.normalize({ analysisChunkMode: "short" }).analysisChunkMode, "short");
  assert.equal(SETTINGS.normalize({ analysisChunkMode: "long" }).analysisChunkMode, "long");
  assert.equal(SETTINGS.normalize({ analysisChunkMode: "unknown" }).analysisChunkMode, "auto");
  assert.equal(SETTINGS.normalize({ analysisChunkMode: "constructor" }).analysisChunkMode, "auto");
});

test("外观两项：默认值、非法值回退与合法值透传", () => {
  assert.equal(SETTINGS.normalize({}).accentTheme, "ink");
  assert.equal(SETTINGS.normalize({}).themeMode, "system");

  assert.equal(SETTINGS.normalize({ accentTheme: "graphite" }).accentTheme, "graphite");
  assert.equal(SETTINGS.normalize({ accentTheme: "ochre" }).accentTheme, "ochre");
  assert.equal(SETTINGS.normalize({ accentTheme: "neon-green" }).accentTheme, "ink");
  assert.equal(SETTINGS.normalize({ themeMode: "dark" }).themeMode, "dark");
  assert.equal(SETTINGS.normalize({ themeMode: "sepia" }).themeMode, "system");
});

test("播放页总结卡片默认开启，只认真正的布尔值", () => {
  assert.equal(SETTINGS.DEFAULTS.inPageCard, true);
  assert.equal(SETTINGS.normalize({}).inPageCard, true, "没有这一项时按默认开启");
  assert.equal(SETTINGS.normalize(undefined).inPageCard, true);
  assert.equal(SETTINGS.normalize({ inPageCard: false }).inPageCard, false);
  assert.equal(SETTINGS.normalize({ inPageCard: true }).inPageCard, true);
  for (const value of ["false", 0, null, "off"]) {
    assert.equal(SETTINGS.normalize({ inPageCard: value }).inPageCard, true, String(value));
  }
  // 设置页每次保存都会把存储里的配置整体规整一遍，关掉的开关不能被冲回默认。
  const saved = SETTINGS.normalize({ inPageCard: false });
  assert.equal(SETTINGS.normalize({ ...saved, accentTheme: "ochre" }).inPageCard, false);
});

test("主题只有三套，默认宣纸墨青", () => {
  assert.deepEqual(Object.keys(SETTINGS.ACCENT_THEMES), ["ink", "graphite", "ochre"]);
  assert.equal(SETTINGS.DEFAULTS.accentTheme, "ink");
  assert.deepEqual(
    Object.values(SETTINGS.ACCENT_THEMES).map((theme) => theme.label),
    ["宣纸墨青", "石墨靛蓝", "暖岩赭石"],
  );
});

test("主题取值任何情况下都落在三套之内", () => {
  const valid = new Set<string>(Object.keys(SETTINGS.ACCENT_THEMES));
  for (const raw of [undefined, null, "", " ink", "INK", "Pink", "toString", "__proto__", "constructor", 1, true, {}, ["ink"], "neon-green"]) {
    const value = SETTINGS.normalize({ accentTheme: raw }).accentTheme;
    assert.ok(valid.has(value), `${String(raw)} → ${value}`);
    assert.equal(value, "ink", `认不出的 ${String(raw)} 回到默认`);
  }
  // 整份配置缺失、不是对象时也一样。
  for (const raw of [undefined, null, "oops", 42]) {
    assert.equal(SETTINGS.normalize(raw).accentTheme, "ink");
  }
});

test("概览分块模式映射成稳定的字符上限，重叠固定 400 字", () => {
  assert.deepEqual(SETTINGS.analysisChunkOptions({ analysisChunkMode: "auto" }), { maxChars: 6000, singleChars: 8000 });
  assert.deepEqual(SETTINGS.analysisChunkOptions({ analysisChunkMode: "short" }), { maxChars: 3500, singleChars: 3500 });
  assert.deepEqual(SETTINGS.analysisChunkOptions({ analysisChunkMode: "long" }), { maxChars: 12000, singleChars: 14000 });
  assert.equal(ANALYSIS_OVERLAP_CHARS, 400);
});

// ============================================================
// 预设
// ============================================================

test("每个预设的地址都能通过自身协议的校验", () => {
  for (const preset of SETTINGS.PRESETS) {
    if (!preset.baseUrl) continue; // 「自定义」故意留空
    const result = validateBaseUrl(preset.baseUrl, preset.protocol);
    assert.equal(result.ok, true, `${preset.label} 的地址不合法`);
    assert.equal(SETTINGS.normalize({ presetId: preset.id }).aiBaseUrl, preset.baseUrl, preset.label);
  }
});

test("预设的协议都在已支持的协议之内", () => {
  const known: readonly Protocol[] = Object.values(PROTOCOLS);
  for (const preset of SETTINGS.PRESETS) {
    assert.ok(known.includes(preset.protocol), `${preset.label} 的协议不受支持`);
  }
});

test("预设 id 不重复，且包含自定义选项", () => {
  const ids = SETTINGS.PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "预设 id 有重复");
  assert.ok(ids.includes(SETTINGS.CUSTOM_PRESET_ID));
});

test("除默认的 Anthropic 和 DeepSeek 外，预设不写死模型名", () => {
  for (const preset of SETTINGS.PRESETS) {
    if (preset.id === "anthropic" || preset.id === "deepseek") continue;
    assert.equal(preset.model, "", `${preset.label} 预置了模型名 ${preset.model}，模型换代后会变成过期的默认值`);
  }
});

test("预设表以地址模块为准：顺序、协议和地址都来自那边，这里只补标签、默认模型和密钥页链接", () => {
  assert.deepEqual(
    SETTINGS.PRESETS.map(({ id, protocol, baseUrl }) => ({ id, protocol, baseUrl })),
    [...ENDPOINT_PRESETS],
  );
  assert.deepEqual(
    SETTINGS.PRESETS.map((preset) => [preset.id, preset.label]),
    [
      ["anthropic", "Anthropic Claude"],
      ["openai", "OpenAI"],
      ["deepseek", "DeepSeek"],
      ["gemini", "Google Gemini（OpenAI 兼容端点）"],
      ["moonshot", "月之暗面 Kimi"],
      ["zhipu", "智谱 GLM"],
      ["dashscope", "阿里云百炼（通义千问）"],
      ["siliconflow", "硅基流动 SiliconFlow"],
      ["openrouter", "OpenRouter"],
      ["custom", "自定义"],
    ],
  );
  assert.equal(SETTINGS.presetById("没有这家"), null);
});

test("快捷选择指向真实的预设，国内在前", () => {
  assert.deepEqual(
    SETTINGS.REGION_PRESETS.map((region) => [region.label, region.presetId]),
    [["国内服务", "deepseek"], ["海外服务", "anthropic"]],
  );
  for (const region of SETTINGS.REGION_PRESETS) assert.ok(SETTINGS.presetById(region.presetId), region.id);
});

// ============================================================
// 固定值和结构
// ============================================================

test("并发和超时是固定值，传输层拿到的就是这份规则", () => {
  assert.equal(SETTINGS.AI_CONCURRENCY, 3);
  assert.equal(SETTINGS.AI_TIMEOUT_SECONDS, 120);
  assert.equal(SETTINGS.settingsRules.timeoutSeconds, SETTINGS.AI_TIMEOUT_SECONDS);
  assert.equal(SETTINGS.settingsRules.dataConsentVersion, DATA_CONSENT_VERSION);
  assert.equal(SETTINGS.settingsRules.dataConsentFingerprint, DATA_CONSENT_FINGERPRINT);
  assert.equal(SETTINGS.settingsRules.dataConsentError, DATA_CONSENT_ERROR);
});

test("默认值就是空配置规整出来的结果，规整结果再规整一遍不变", () => {
  assert.deepEqual(SETTINGS.normalize({}), { ...SETTINGS.DEFAULTS });
  for (const preset of SETTINGS.PRESETS) {
    const normalized = SETTINGS.normalize({ presetId: preset.id, aiApiKey: "k", aiModel: "m", aiBaseUrl: "https://a.example.com/v1" });
    assert.deepEqual(SETTINGS.normalize(normalized), normalized, preset.id);
  }
});

test("认不出的键规整后不留下，其余设置照常读出", () => {
  const normalized = SETTINGS.normalize({
    presetId: "custom",
    aiBaseUrl: "https://api.example.com/v1",
    aiApiKey: "sk-test",
    aiModel: "m",
    unknownSetting: 1,
    anotherUnknown: { a: 1 },
  });
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(SETTINGS.DEFAULTS).sort());
  assert.equal(normalized.aiApiKey, "sk-test");
  assert.equal(normalized.aiModel, "m");
});

// ============================================================
// 保存配置与调用 AI 分开校验
// ============================================================

test("没填密钥和模型也能保存，但还不能调用 AI", () => {
  const input = { presetId: "openai" };
  const save = SETTINGS.validateForSave(input);
  assert.equal(save.ok, true);
  assert.deepEqual(save.errors, []);
  const ready = SETTINGS.validate(input);
  assert.equal(ready.ok, false);
  assert.match(ready.errors.join(" "), /请填写 API 密钥/);
});

test("地址不合法时不能保存", () => {
  const save = SETTINGS.validateForSave({ presetId: SETTINGS.CUSTOM_PRESET_ID, aiBaseUrl: "ftp://api.example.com" });
  assert.equal(save.ok, false);
  assert.deepEqual(save.errors, [HTTPS_ERROR]);
});

test("Responses 协议：粘贴的完整端点剥回 base，其他协议不碰 /responses", () => {
  assert.equal(urlOf("https://api.openai.com/v1/responses", PROTOCOLS.RESPONSES), "https://api.openai.com/v1");
  assert.equal(
    urlOf("https://proxy.example.com/v1/responses", PROTOCOLS.OPENAI),
    "https://proxy.example.com/v1/responses",
    "Chat Completions 的地址恰好以 /responses 结尾时不能被改",
  );
  const normalized = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.RESPONSES,
    aiApiKey: "k",
    aiBaseUrl: "https://proxy.example.com/v1/responses",
    aiModel: "m",
  });
  assert.equal(normalized.protocol, PROTOCOLS.RESPONSES);
  assert.equal(chatCompletionsUrl(normalized), "https://proxy.example.com/v1/responses");
  assert.equal(modelsUrl(normalized), "https://proxy.example.com/v1/models");
});

// ============================================================
// 按功能选模型
// ============================================================

const ANTHROPIC_SAVED = Object.freeze({
  presetId: "anthropic",
  aiApiKey: "sk-ant-test",
  ...CONSENTED,
  aiModel: "claude-opus-5-5",
  featureModels: { verdict: "claude-haiku-5-0", explain: "claude-haiku-5-0" },
});

test("覆盖只认已知功能下的非空字符串，去掉首尾空白", () => {
  const normalized = SETTINGS.normalize({
    ...ANTHROPIC_SAVED,
    featureModels: {
      analysis: "  claude-opus-5-5  ",
      verdict: "   ",
      rewrite: 42,
      qa: null,
      notes: ["claude-haiku-5-0"],
      explain: "claude-haiku-5-0",
      translate: "不是功能名",
      __proto__: { qa: "原型链上的值" },
    },
  });
  assert.deepEqual(normalized.featureModels, { analysis: "claude-opus-5-5", explain: "claude-haiku-5-0" });
  assert.deepEqual(SETTINGS.normalize({ featureModels: "claude" }).featureModels, {});
  assert.deepEqual(SETTINGS.normalize({ featureModels: ["a"] }).featureModels, {});
  assert.deepEqual(SETTINGS.normalize(undefined).featureModels, {});
  assert.equal(
    SETTINGS.normalize({ featureModels: { qa: "m".repeat(500) } }).featureModels.qa?.length,
    200,
    "和默认模型同一个长度上限",
  );
});

test("功能列表就是设置页那六项，id 不重复", () => {
  assert.deepEqual(
    SETTINGS.FEATURE_MODEL_SLOTS.map((slot) => [slot.id, slot.label]),
    [
      ["analysis", "概览"],
      ["verdict", "一句话结论"],
      ["rewrite", "翻译"],
      ["qa", "问答"],
      ["notes", "笔记润色"],
      ["explain", "划词解释"],
    ],
  );
});

test("保存过的覆盖记下所属的服务商和地址，再规整一遍不变", () => {
  const normalized = SETTINGS.normalize(ANTHROPIC_SAVED);
  assert.deepEqual(normalized.featureModels, ANTHROPIC_SAVED.featureModels);
  assert.equal(normalized.featureModelsOwner, "anthropic|https://api.anthropic.com/");
  assert.equal(SETTINGS.featureModelsOwnerOf(ANTHROPIC_SAVED), "anthropic|https://api.anthropic.com/");
  // 外观这类即改即存的设置都是「读出、规整、写回」，不能弄丢覆盖。
  assert.deepEqual(SETTINGS.normalize(normalized), normalized);
  assert.deepEqual(SETTINGS.normalize({ ...normalized, accentTheme: "ochre" }).featureModels, ANTHROPIC_SAVED.featureModels);
});

test("没有覆盖时不记归属", () => {
  assert.equal(SETTINGS.normalize({ presetId: "anthropic" }).featureModelsOwner, "");
  assert.equal(SETTINGS.normalize({ presetId: "anthropic", featureModels: { qa: " " } }).featureModelsOwner, "");
});

test("切换服务商预设后，原来按功能选的模型全部清空", () => {
  const saved = SETTINGS.normalize(ANTHROPIC_SAVED);
  for (const presetId of ["openai", "deepseek", SETTINGS.CUSTOM_PRESET_ID]) {
    const isCustom = presetId === SETTINGS.CUSTOM_PRESET_ID;
    const switched = SETTINGS.normalize({
      ...saved,
      presetId,
      aiBaseUrl: isCustom ? "https://api.anthropic.com" : undefined,
      protocol: isCustom ? PROTOCOLS.ANTHROPIC : undefined,
    });
    assert.deepEqual(switched.featureModels, {}, `${presetId} 不该沿用 Anthropic 的模型名`);
    assert.equal(switched.featureModelsOwner, "");
    assert.equal(SETTINGS.modelForFeature(switched, "verdict"), switched.aiModel);
  }
});

test("自定义地址换了域名同样清空；只换路径不受影响", () => {
  const base = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    aiBaseUrl: "https://proxy-a.example.com/v1",
    aiApiKey: "sk-proxy",
    ...CONSENTED,
    aiModel: "big",
    featureModels: { verdict: "small" },
  });
  assert.equal(base.featureModelsOwner, "custom|https://proxy-a.example.com/");
  assert.deepEqual(SETTINGS.normalize({ ...base, aiBaseUrl: "https://proxy-b.example.com/v1" }).featureModels, {});
  assert.deepEqual(SETTINGS.normalize({ ...base, aiBaseUrl: "https://proxy-a.example.com/openai/v1" }).featureModels, {
    verdict: "small",
  });
});

test("地址不合法时覆盖原样保留，等地址改好再判断", () => {
  const stored = {
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    aiBaseUrl: "不是地址",
    featureModels: { qa: "m" },
    featureModelsOwner: "custom|https://proxy-a.example.com/",
  };
  const normalized = SETTINGS.normalize(stored);
  assert.deepEqual(normalized.featureModels, { qa: "m" });
  assert.equal(normalized.featureModelsOwner, "custom|https://proxy-a.example.com/");
  assert.equal(SETTINGS.featureModelsOwnerOf(stored), "");
});

test("validate：覆盖不能代替默认模型，无效的覆盖不挡请求", () => {
  // OpenAI 预设没有预置模型；Anthropic 预置了默认模型，测不出这一条。
  const noDefault = SETTINGS.validate({
    presetId: "openai",
    aiApiKey: "sk-openai-test",
    ...CONSENTED,
    featureModels: Object.fromEntries(SETTINGS.FEATURE_MODEL_SLOTS.map((slot) => [slot.id, "m"])),
  });
  assert.equal(noDefault.ok, false);
  assert.deepEqual(noDefault.errors, [MODEL_ERROR]);

  const messy = SETTINGS.validate({
    ...ANTHROPIC_SAVED,
    featureModels: { analysis: "", verdict: "  claude-haiku-5-0 ", qa: 7 },
  });
  assert.equal(messy.ok, true, JSON.stringify(messy.errors));
  assert.deepEqual(messy.settings.featureModels, { verdict: "claude-haiku-5-0" });

  const ready = SETTINGS.validateForSave({ ...ANTHROPIC_SAVED, featureModels: { qa: "x" } });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.settings.featureModels, { qa: "x" });
});

test("modelForFeature：设了用覆盖，留空或认不出的功能名用默认模型", () => {
  const settings = SETTINGS.normalize(ANTHROPIC_SAVED);
  assert.equal(SETTINGS.modelForFeature(settings, "verdict"), "claude-haiku-5-0");
  assert.equal(SETTINGS.modelForFeature(settings, "analysis"), "claude-opus-5-5");
  assert.equal(SETTINGS.modelForFeature(settings, undefined), "claude-opus-5-5");
  assert.equal(SETTINGS.modelForFeature(settings, "constructor"), "claude-opus-5-5");
  assert.equal(SETTINGS.modelForFeature(settings, "__proto__"), "claude-opus-5-5");

  const swapped = SETTINGS.withFeatureModel(settings, "explain");
  assert.equal(swapped.aiModel, "claude-haiku-5-0");
  assert.equal(swapped.aiBaseUrl, settings.aiBaseUrl);
  assert.equal(settings.aiModel, "claude-opus-5-5", "不改动传进来的设置");
  assert.equal(SETTINGS.withFeatureModel(settings, "qa"), settings, "没有覆盖时原样返回");
});

// ============================================================
// 密钥和来源的绑定
// ============================================================

test("密钥记录的来源与当前地址不一致时视为没填", () => {
  const normalized = SETTINGS.normalize({
    presetId: "deepseek",
    aiApiKey: OPENAI_KEY,
    aiApiKeyOrigin: "https://api.openai.com/",
    aiModel: "deepseek-v4-flash",
  });
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiApiKey, "", "OpenAI 的密钥不能跟着 DeepSeek 的地址走");
  assert.equal(normalized.aiApiKeyOrigin, "");
  assert.deepEqual(SETTINGS.validate(normalized).errors, [KEY_ERROR, DATA_CONSENT_ERROR]);
});

test("自定义地址换了域名，旧密钥同样作废；只换路径不受影响", () => {
  const base = {
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    aiApiKey: "sk-proxy",
    aiApiKeyOrigin: "https://proxy-a.example.com/",
    aiModel: "m",
  };
  assert.equal(SETTINGS.normalize({ ...base, aiBaseUrl: "https://proxy-b.example.com/v1" }).aiApiKey, "");
  // 端口也是来源的一部分。
  assert.equal(SETTINGS.normalize({ ...base, aiBaseUrl: "https://proxy-a.example.com:8443/v1" }).aiApiKey, "");
  const samePlace = SETTINGS.normalize({ ...base, aiBaseUrl: "https://proxy-a.example.com/openai/v1" });
  assert.equal(samePlace.aiApiKey, "sk-proxy");
  assert.equal(samePlace.aiApiKeyOrigin, "https://proxy-a.example.com/");
});

test("来源字段是乱填的值时宁可作废密钥", () => {
  const normalized = SETTINGS.normalize({ presetId: "openai", aiApiKey: OPENAI_KEY, aiApiKeyOrigin: "不是地址" });
  assert.equal(normalized.aiApiKey, "");
});

test("没有密钥时不记录来源", () => {
  assert.equal(SETTINGS.normalize({ presetId: "openai" }).aiApiKeyOrigin, "");
  assert.equal(SETTINGS.normalize(undefined).aiApiKeyOrigin, "");
});

test("刚填的密钥没有来源时归到当前地址，规整后补上来源", () => {
  const normalized = SETTINGS.normalize({ presetId: "openai", aiApiKey: OPENAI_KEY });
  assert.equal(normalized.aiApiKey, OPENAI_KEY);
  assert.equal(normalized.aiApiKeyOrigin, "https://api.openai.com/");
  // 再规整一遍不变，换了服务商就作废，不会跟着发给别家。
  assert.deepEqual(SETTINGS.normalize(normalized), normalized);
  assert.equal(SETTINGS.normalize({ ...normalized, presetId: "deepseek" }).aiApiKey, "");
});

// ============================================================
// 首次启用确认
// ============================================================

const activationUpdated = (status: ReturnType<typeof SETTINGS.activationStatus>): boolean =>
  status.state === "needed" && status.updated;

test("启用确认：新安装没确认，要看完整说明；确认过当前说明才算数", () => {
  assert.equal(SETTINGS.DEFAULTS.activationVersion, 0);
  assert.equal(SETTINGS.DEFAULTS.activationFingerprint, "");
  const fresh = SETTINGS.activationStatus({});
  assert.equal(fresh.state, "needed");
  assert.equal(activationUpdated(fresh), false, "从没确认过，不是说明有更新");
  assert.deepEqual(fresh.state === "needed" ? fresh.items : [], ACTIVATION_TABLE.flatMap((row) => row.items));
  assert.deepEqual(SETTINGS.activationStatus(SETTINGS.ACTIVATION_CONFIRMED), { state: "current" });
  assert.equal(SETTINGS.ACTIVATION_CONFIRMED.activationVersion, ACTIVATION_VERSION);
  assert.equal(SETTINGS.ACTIVATION_CONFIRMED.activationFingerprint, ACTIVATION_FINGERPRINT);
});

test("启用确认：说明版本或指纹和当前不一致就失效，提示说明有更新", () => {
  const stale = [
    { ...SETTINGS.ACTIVATION_CONFIRMED, activationFingerprint: STALE_FINGERPRINT },
    { ...SETTINGS.ACTIVATION_CONFIRMED, activationFingerprint: "" },
    { ...SETTINGS.ACTIVATION_CONFIRMED, activationVersion: ACTIVATION_VERSION + 1 },
  ];
  for (const stored of stale) {
    const status = SETTINGS.activationStatus(stored);
    assert.equal(status.state, "needed", JSON.stringify(stored));
    assert.equal(activationUpdated(status), true, JSON.stringify(stored));
  }
  // 只存了指纹、没有版本，认不出确认过什么，按从没确认过处理。
  assert.equal(activationUpdated(SETTINGS.activationStatus({ activationFingerprint: ACTIVATION_FINGERPRINT })), false);
});

test("启用确认的字段只核对形状：坏值落回没确认，好值留着，改别的设置不丢", () => {
  for (const bad of ["1", 1.5, -1, null, true]) {
    assert.equal(SETTINGS.normalize({ activationVersion: bad }).activationVersion, 0, String(bad));
  }
  assert.equal(SETTINGS.normalize({ activationFingerprint: 7 }).activationFingerprint, "");

  // 认不出确认的是旧版时也留着存下的值，下次才能判断说明有没有更新。
  const stale = { activationVersion: ACTIVATION_VERSION, activationFingerprint: STALE_FINGERPRINT };
  const normalized = SETTINGS.normalize(stale);
  assert.equal(normalized.activationVersion, ACTIVATION_VERSION);
  assert.equal(normalized.activationFingerprint, STALE_FINGERPRINT);

  const confirmed = SETTINGS.normalize({ ...SETTINGS.ACTIVATION_CONFIRMED });
  assert.deepEqual(SETTINGS.activationStatus({ ...confirmed, accentTheme: "ochre" }), { state: "current" });
});

test("启用确认和数据同意分开判断：确认了一边不等于确认了另一边", () => {
  const onlyConsent = SETTINGS.normalize({ ...CONSENTED });
  assert.equal(SETTINGS.activationStatus(onlyConsent).state, "needed");

  const onlyActivated = { presetId: "deepseek", aiApiKey: "sk-test", ...SETTINGS.ACTIVATION_CONFIRMED };
  assert.deepEqual(SETTINGS.validate(onlyActivated).errors, [DATA_CONSENT_ERROR]);
});
