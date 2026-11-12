// 设置页「AI 服务」一节：服务商、地址、密钥和记住密钥、默认模型和按功能选模型、概览分块、数据说明和同意、保存和测试。
import { useId } from "preact/hooks";
import { DATA_CONSENT_TABLE, noticeLines, noticeStatus, type DataConsentKind, type NoticeItem } from "../../core/consent.ts";
import {
  ANALYSIS_CHUNK_MODES,
  CUSTOM_PRESET_ID,
  FEATURE_MODEL_SLOTS,
  PRESETS,
  presetById,
  REGION_PRESETS,
  type AnalysisChunkMode,
} from "../../shared/settings-schema.ts";
import { Button } from "../shared/ui/button.tsx";
import { Confirmable, StatusLine } from "./controls.tsx";
import { showsRegionChooser } from "./form.ts";
import type { OptionsState } from "./state.ts";

const MODEL_LIST_ID = "model-options";


const PROTOCOL_LABELS: readonly [string, string][] = [
  ["openai", "OpenAI 兼容（多数服务）"],
  ["openai-responses", "OpenAI Responses（OpenAI 官方）"],
  ["anthropic", "Anthropic（Claude）"],
];

const CHUNK_LABELS: Readonly<Record<AnalysisChunkMode, string>> = {
  auto: "自动（推荐）",
  short: "较短：请求数更多，更稳",
  long: "较长：请求数更少，更快",
};

const CONSENT_HEADINGS: readonly [DataConsentKind, string][] = [
  ["category", "会发送"],
  ["purpose", "用在"],
  ["recipient", "发给谁"],
  ["trigger", "什么时候发"],
];

const FULL_CONSENT = noticeStatus(DATA_CONSENT_TABLE, {});
const FULL_CONSENT_ITEMS = FULL_CONSENT.state === "needed" ? FULL_CONSENT.items : [];

function ConsentLines({ items }: { readonly items: readonly NoticeItem<DataConsentKind>[] }) {
  const lines = noticeLines(items);
  return (
    <dl class="consent-lines">
      {CONSENT_HEADINGS.map(([kind, heading]) => {
        const texts = lines.filter((line) => line.kind === kind).map((line) => line.text);
        return texts.length ? (
          <div key={kind} class="consent-row">
            <dt>{heading}</dt>
            <dd>{texts.join("；")}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}

function ConsentBox({ state }: { readonly state: OptionsState }) {
  const saved = state.saved.value;
  if (!saved) return null;
  const status = noticeStatus(DATA_CONSENT_TABLE, { version: saved.dataConsentVersion, fingerprint: saved.dataConsentFingerprint });
  const given = status.state === "current";
  return (
    <div class="consent" id="dataConsentBox">
      <p class="consent-title">使用 AI 功能时会发送什么</p>
      {status.state === "needed" && status.updated ? (
        <>
          <p class="field-hint">说明有更新，新增的内容：</p>
          <ConsentLines items={status.items} />
          <details>
            <summary>查看完整说明</summary>
            <ConsentLines items={FULL_CONSENT_ITEMS} />
          </details>
        </>
      ) : (
        <ConsentLines items={FULL_CONSENT_ITEMS} />
      )}
      <label class="check">
        <input id="dataConsent" type="checkbox" checked={given} onChange={(event) => void state.setConsent(event.currentTarget.checked)} />
        <span>我已了解，同意在我使用 AI 功能时发送上述内容</span>
      </label>
      <span class="field-hint">没勾选时不发任何 AI 请求。取消勾选马上生效。</span>
    </div>
  );
}

export function AiSection({ state }: { readonly state: OptionsState }) {
  const form = state.form.value;
  const saved = state.saved.value;
  const busy = state.busy.value;
  const id = useId();
  if (!form || !saved) return null;
  const preset = presetById(form.presetId);
  const custom = form.presetId === CUSTOM_PRESET_ID;
  const hasFeatureModels = FEATURE_MODEL_SLOTS.some(({ id: slot }) => (form.featureModels[slot] ?? "").trim() !== "");
  const working = busy !== null;
  return (
    <section class="card" id="ai-service" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>AI 服务</h2>
      <p class="hint">
        翻译、概览、划词解释、笔记润色和问答要调用大模型服务。选好服务商，填 API 密钥和模型名称就行，地址已经内置；列表里没有的服务选「自定义」，自己填地址和协议。密钥只发到所选服务商的地址。
      </p>
      <datalist id={MODEL_LIST_ID}>
        {state.models.value.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      {showsRegionChooser(saved) ? (
        <div class="field">
          <span class="field-label">先选一类服务</span>
          <span class="field-row">
            {REGION_PRESETS.map((region) => (
              <Button key={region.id} onClick={() => state.choosePreset(region.presetId)}>
                {region.label}
              </Button>
            ))}
          </span>
          <span class="field-hint">只是帮你预填服务商，也可以直接在下面的列表里选。能不能开通账户、数据存在哪里，以各服务商为准。</span>
        </div>
      ) : null}

      <label class="field">
        <span class="field-label">服务商</span>
        <select class="input" id="preset" value={form.presetId} onChange={(event) => state.choosePreset(event.currentTarget.value)}>
          {PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        {preset?.docsUrl ? (
          <span class="field-hint">
            到{" "}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer">
              {preset.label} 的控制台
            </a>{" "}
            创建 API 密钥。
          </span>
        ) : null}
      </label>

      {custom ? (
        <>
          <label class="field">
            <span class="field-label">API 协议</span>
            <select class="input" id="protocol" value={form.protocol} onChange={(event) => state.editAddress({ protocol: event.currentTarget.value })}>
              {PROTOCOL_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <span class="field-hint">除 Anthropic 外，主流服务多用 OpenAI 兼容协议，拿不准就选它。</span>
          </label>
          <label class="field">
            <span class="field-label">API 地址</span>
            <input
              class="input"
              id="aiBaseUrl"
              type="url"
              autocomplete="off"
              spellcheck={false}
              placeholder="https://api.example.com/v1"
              value={form.aiBaseUrl}
              onChange={(event) => state.editAddress({ aiBaseUrl: event.currentTarget.value })}
            />
            <span class="field-hint">填到版本号就行，只认 https。</span>
          </label>
        </>
      ) : null}

      <div class="field">
        <label class="field-label" for="aiApiKey">
          API 密钥
        </label>
        <span class="field-row">
          <input
            class="input"
            id="aiApiKey"
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="sk-..."
            value={form.aiApiKey}
            onInput={(event) => state.editKey(event.currentTarget.value)}
          />
          <Confirmable
            label="清除密钥"
            question="删除保存的 API 密钥？会话里和这台电脑上记住的都会删掉，删除后要重新填写才能用 AI 功能。"
            confirmLabel="删除密钥"
            disabled={working}
            onConfirm={() => void state.clearKey()}
          />
        </span>
        <span class="field-hint">默认只存在本次浏览器会话的内存里，不写入磁盘：重启浏览器，或者扩展停用、重新加载、更新以后，要重新填写。</span>
      </div>

      <label class="check">
        <input id="rememberApiKey" type="checkbox" checked={form.rememberApiKey} onChange={(event) => void state.setRemember(event.currentTarget.checked)} />
        <span>在这台电脑上记住密钥</span>
      </label>
      <span class="field-hint">
        勾上并点「保存并授权」以后，密钥以未加密的形式存在本机的扩展存储里，重启浏览器后还能用。能读这台电脑浏览器数据的程序或人可能拿到密钥，共用电脑上不要开；担心泄露可以到服务商后台撤销这把密钥。取消勾选马上删掉本机那份，密钥只留在本次会话里。密钥不进备份，也不随浏览器账号同步。
      </span>

      <div class="field">
        <label class="field-label" for="aiModel">
          模型
        </label>
        <span class="field-row">
          <input
            class="input"
            id="aiModel"
            type="text"
            list={MODEL_LIST_ID}
            autocomplete="off"
            spellcheck={false}
            placeholder="填写模型名称，或点右边的按钮拉取"
            value={form.aiModel}
            onInput={(event) => state.edit({ aiModel: event.currentTarget.value })}
          />
          <Button disabled={working} onClick={() => void state.fetchModels()}>
            {busy === "models" ? "正在拉取" : "拉取模型列表"}
          </Button>
        </span>
        <span class="field-hint">拉取会先按表单保存一次，再向服务商要当前可用的模型。</span>
      </div>

      <details class="field" id="featureModels" open={hasFeatureModels}>
        <summary>按功能选模型（可选）</summary>
        <span class="field-hint">
          同一个服务商、同一把密钥下，可以给单项功能另选模型，留空就用上面的默认模型。一句话结论、翻译、划词解释这类短任务可以选更快更便宜的；概览和问答建议用能力更强的。换服务商时这里会清空。
        </span>
        {FEATURE_MODEL_SLOTS.map((slot) => (
          <label key={slot.id} class="feature-row">
            <span class="feature-label">{slot.label}</span>
            <input
              class="input"
              data-feature={slot.id}
              type="text"
              list={MODEL_LIST_ID}
              autocomplete="off"
              spellcheck={false}
              placeholder={form.aiModel || "默认模型"}
              value={form.featureModels[slot.id] ?? ""}
              onInput={(event) => state.editFeatureModel(slot.id, event.currentTarget.value)}
            />
          </label>
        ))}
      </details>

      <label class="field">
        <span class="field-label">概览分块</span>
        <select class="input" id="analysisChunkMode" value={form.analysisChunkMode} onChange={(event) => state.edit({ analysisChunkMode: event.currentTarget.value as AnalysisChunkMode })}>
          {(Object.keys(ANALYSIS_CHUNK_MODES) as AnalysisChunkMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {CHUNK_LABELS[mode]}
            </option>
          ))}
        </select>
        <span class="field-hint">多数模型用自动就好。上下文窗口小、内容有遗漏，或者长视频的请求超时（单次上限 120 秒）时选「较短」。</span>
      </label>

      <ConsentBox state={state} />

      <div class="actions">
        <Button variant="primary" disabled={working} onClick={() => void state.save()}>
          {busy === "save" ? "正在保存" : "保存并授权"}
        </Button>
        <Button disabled={working} onClick={() => void state.testConnection(false)}>
          {busy === "test" ? "正在测试" : "测试连接"}
        </Button>
        {hasFeatureModels ? (
          <Button disabled={working} onClick={() => void state.testConnection(true)}>
            测试全部模型
          </Button>
        ) : null}
      </div>
      <StatusLine status={state.aiStatus.value} />
      <p class="hint">
        点「保存并授权」时，浏览器会问是否允许简幕访问所选服务商的域名。扩展安装时不知道你会用哪家服务，所以选定以后单独申请，而且只申请这一个域名。
      </p>
    </section>
  );
}
