// 设置页「AI 服务」一节：先是要点「保存」的表单（服务商、地址、密钥和记住密钥、默认模型和按功能选模型），
// 接着数据说明和同意、保存和测试；按钮后面是即改即存的推理强度和概览分块，收在一个折叠里，值按存着的设置显示。
// 状态行跟着控件走：清除密钥、记住密钥、拉取模型、推理强度、概览分块的结果写在各自下面，保存和测试连接的写在按钮下面。
// 保存了密钥、还没记住也没问过时，按钮下面就地问一句要不要记在这台电脑上。
import { useEffect, useId, useRef } from "preact/hooks";
import { DATA_CONSENT_TABLE, noticeLines, noticeStatus, type DataConsentKind, type NoticeItem } from "../../core/consent.ts";
import { EFFORTS } from "../../core/ai/effort-level.ts";
import {
  ANALYSIS_CHUNK_MODES,
  CUSTOM_PRESET_ID,
  FEATURE_MODEL_SLOTS,
  PRESETS,
  presetById,
  REGION_PRESETS,
  type AnalysisChunkMode,
} from "../../shared/settings-schema.ts";
import { dataConsentStatus } from "../../shared/consent-status.ts";
import { Button } from "../shared/ui/button.tsx";
import { AiStatusLine, Confirmable } from "./controls.tsx";
import { ImageProbeButton } from "./image-probe-button.tsx";
import { ModelField } from "./model-field.tsx";
import { effortNoteText, serviceChanged, showsRegionChooser, usageText } from "./form.ts";
import type { OptionsState } from "./state.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { optionsText, slotLabel } from "./text.ts";

const PROTOCOLS = ["openai", "openai-responses", "anthropic"] as const;

const CONSENT_KINDS: readonly DataConsentKind[] = ["category", "purpose", "recipient", "trigger"];

const FULL_CONSENT = noticeStatus(DATA_CONSENT_TABLE, {});
const FULL_CONSENT_ITEMS = FULL_CONSENT.state === "needed" ? FULL_CONSENT.items : [];

export function ConsentLines({ items }: { readonly items: readonly NoticeItem<DataConsentKind>[] }) {
  const t = optionsText().consent;
  const lines = noticeLines(items, uiLang.value);
  return (
    <dl class="consent-lines">
      {CONSENT_KINDS.map((kind) => {
        const texts = lines.filter((line) => line.kind === kind).map((line) => line.text);
        return texts.length ? (
          <div key={kind} class="consent-row">
            <dt>{t.headings[kind]}</dt>
            <dd>{texts.join(t.joiner)}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}

function ConsentBox({ state }: { readonly state: OptionsState }) {
  const t = optionsText().consent;
  const saved = state.saved.value;
  if (!saved) return null;
  const status = dataConsentStatus(saved);
  const given = status.state === "current";
  return (
    <div class="consent" id="dataConsentBox">
      <p class="consent-title">{t.title}</p>
      {status.state === "needed" && status.updated ? (
        <>
          <p class="field-hint">{t.updated}</p>
          <ConsentLines items={status.items} />
          <details>
            <summary>{t.full}</summary>
            <ConsentLines items={FULL_CONSENT_ITEMS} />
          </details>
        </>
      ) : (
        <ConsentLines items={FULL_CONSENT_ITEMS} />
      )}
      <label class="check">
        <input id="dataConsent" type="checkbox" checked={given} onChange={(event) => void state.setConsent(event.currentTarget.checked)} />
        <span>{t.agree}</span>
      </label>
      <span class="field-hint">{t.agreeHint}</span>
    </div>
  );
}

function EffortBlock({ state }: { readonly state: OptionsState }) {
  const t = optionsText().efforts;
  const lang = uiLang.value;
  const form = state.form.value;
  const saved = state.saved.value;
  const items = state.efforts.value;
  // 启用以后这一节才挂上，挂上时再问一次：启用之前后台不回。
  useEffect(() => void state.refreshEfforts(), [state]);
  if (!form || !saved) return null;
  const pending = serviceChanged(form, saved);
  return (
    <fieldset class="field effort-block" id="featureEfforts">
      <legend class="field-label">{t.title}</legend>
      <div>
        <span class="field-hint">{t.hint}</span>
        <AiStatusLine state={state} at="efforts" />
      </div>
      {FEATURE_MODEL_SLOTS.map((slot) => {
        const item = pending ? undefined : items?.find((entry) => entry.feature === slot.id && entry.requested === saved.featureEfforts[slot.id]);
        const note = item ? effortNoteText(item, lang) : null;
        const latest = items?.find((entry) => entry.feature === slot.id);
        const usage = latest ? usageText(latest, lang) : null;
        return (
          <label key={slot.id} class="feature-row">
            <span class="feature-label">{slotLabel(slot.id, lang)}</span>
            <span class="effort-choice">
              <select
                class="input"
                data-effort={slot.id}
                value={saved.featureEfforts[slot.id]}
                onChange={(event) => void state.saveInstant({ featureEfforts: { [slot.id]: event.currentTarget.value } })}
              >
                {EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {t.labels[effort]}
                  </option>
                ))}
              </select>
              {note ? (
                <span class="field-hint effort-note" data-effort-note={slot.id}>
                  {note}
                </span>
              ) : null}
              {usage ? (
                <span class="field-hint effort-usage" data-usage={slot.id}>
                  {usage}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
      {pending ? <span class="field-hint">{t.pending}</span> : null}
    </fieldset>
  );
}

/**
 * 推理强度和概览分块：多数人不用动，收在一个折叠里，标题写明里面是什么。两项即改即存，不归「保存」管，排在按钮后面。
 * 打开设置页时有一项不是默认值就展开着；之后开合只听用户的，改回默认值也不替他收起来。
 */
function AdvancedBlock({ state, saved }: { readonly state: OptionsState; readonly saved: NonNullable<OptionsState["saved"]["value"]> }) {
  const t = optionsText().ai;
  const open = useRef(saved.analysisChunkMode !== "auto" || FEATURE_MODEL_SLOTS.some(({ id }) => saved.featureEfforts[id] !== "off"));
  return (
    <details class="field" id="advanced" open={open.current}>
      <summary>{t.advanced}</summary>
      {/* 折叠里的内容不归 details 自己的间距管，另包一层来隔开两块。 */}
      <div class="fold-body">
        <EffortBlock state={state} />

        <div>
          <label class="field">
            <span class="field-label">{t.chunk}</span>
            <select class="input" id="analysisChunkMode" value={saved.analysisChunkMode} onChange={(event) => void state.saveInstant({ analysisChunkMode: event.currentTarget.value })}>
              {(Object.keys(ANALYSIS_CHUNK_MODES) as AnalysisChunkMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {t.chunks[mode]}
                </option>
              ))}
            </select>
            <span class="field-hint">{t.chunkHint}</span>
          </label>
          <AiStatusLine state={state} at="chunk" />
        </div>
      </div>
    </details>
  );
}

export function AiSection({ state }: { readonly state: OptionsState }) {
  const t = optionsText().ai;
  const lang = uiLang.value;
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
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      {showsRegionChooser(saved) ? (
        <div class="field">
          <span class="field-label">{t.regionTitle}</span>
          <span class="field-row">
            {REGION_PRESETS.map((region) => (
              <Button key={region.id} onClick={() => state.choosePreset(region.presetId)}>
                {t.regions[region.id]}
              </Button>
            ))}
          </span>
          <span class="field-hint">{t.regionHint}</span>
        </div>
      ) : null}

      <label class="field">
        <span class="field-label">{t.provider}</span>
        <select class="input" id="preset" value={form.presetId} onChange={(event) => state.choosePreset(event.currentTarget.value)}>
          {PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {t.presets[item.id]}
            </option>
          ))}
        </select>
        {preset?.docsUrl ? (
          <span class="field-hint">
            {t.docsBefore}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer">
              {t.docsLink(t.presets[preset.id])}
            </a>
            {t.docsAfter}
          </span>
        ) : null}
      </label>

      {custom ? (
        <>
          <label class="field">
            <span class="field-label">{t.protocol}</span>
            <select class="input" id="protocol" value={form.protocol} onChange={(event) => state.editAddress({ protocol: event.currentTarget.value })}>
              {PROTOCOLS.map((value) => (
                <option key={value} value={value}>
                  {t.protocols[value]}
                </option>
              ))}
            </select>
            <span class="field-hint">{t.protocolHint}</span>
          </label>
          <label class="field">
            <span class="field-label">{t.baseUrl}</span>
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
            <span class="field-hint">{t.baseUrlHint}</span>
          </label>
        </>
      ) : null}

      <div class="field">
        <label class="field-label" for="aiApiKey">
          {t.apiKey}
        </label>
        <div>
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
              label={t.clearKey}
              question={t.clearKeyQuestion}
              confirmLabel={t.clearKeyConfirm}
              disabled={working}
              onConfirm={() => void state.clearKey()}
            />
          </span>
          <AiStatusLine state={state} at="key" />
        </div>
        <span class="field-hint">
          {t.keyHint}
          {/* 只有本机跑的服务可能不要密钥：Ollama 和自定义地址。 */}
          {custom || form.presetId === "ollama" ? t.localKeyHint : null}
        </span>
      </div>

      <div>
        <label class="check">
          {/* 保存进行中不能动：保存按点击时的勾选写，中途取消会被它盖回去。 */}
          <input id="rememberApiKey" type="checkbox" checked={form.rememberApiKey} disabled={working} onChange={(event) => void state.setRemember(event.currentTarget.checked)} />
          <span>{t.remember}</span>
        </label>
        <AiStatusLine state={state} at="remember" />
      </div>
      <span class="field-hint">{t.rememberHint}</span>

      <div class="field">
        <label class="field-label" for="aiModel">
          {t.model}
        </label>
        <div>
          <span class="field-row">
            <ModelField
              id="aiModel"
              models={state.models.value}
              value={form.aiModel}
              placeholder={t.modelPlaceholder}
              pickLabel={t.modelPick}
              onValue={(aiModel) => state.edit({ aiModel })}
            />
            <Button disabled={working} onClick={() => void state.fetchModels()}>
              {busy === "models" ? t.fetching : t.fetch}
            </Button>
          </span>
          <AiStatusLine state={state} at="model" />
        </div>
        <span class="field-hint">{t.modelHint}</span>
      </div>

      <details class="field" id="featureModels" open={hasFeatureModels}>
        <summary>{t.featureModels}</summary>
        <span class="field-hint">{t.featureHint}</span>
        {FEATURE_MODEL_SLOTS.map((slot) => (
          <div key={slot.id} class="feature-row">
            <label class="feature-label" for={`featureModel-${slot.id}`}>
              {slotLabel(slot.id, lang)}
            </label>
            <ModelField
              id={`featureModel-${slot.id}`}
              feature={slot.id}
              models={state.models.value}
              value={form.featureModels[slot.id] ?? ""}
              placeholder={form.aiModel || t.defaultModel}
              pickLabel={t.featurePick(slotLabel(slot.id, lang))}
              onValue={(model) => state.editFeatureModel(slot.id, model)}
            />
          </div>
        ))}
        {FEATURE_FRAME_EXPLAIN ? <ImageProbeButton state={state} /> : null}
      </details>

      <ConsentBox state={state} />

      <div class="actions">
        <Button variant="primary" disabled={working} onClick={() => void state.save()}>
          {busy === "save" ? t.saving : t.save}
        </Button>
        <Button disabled={working} onClick={() => void state.testConnection(false)}>
          {busy === "test" ? t.testing : t.test}
        </Button>
        {hasFeatureModels ? (
          <Button disabled={working} onClick={() => void state.testConnection(true)}>
            {t.testAll}
          </Button>
        ) : null}
      </div>
      <AiStatusLine state={state} at="actions" />
      {state.rememberAsk.value ? (
        <div class="confirm" id="rememberAsk" role="group" aria-label={t.rememberAsk.label}>
          <p class="confirm-question">{t.rememberAsk.question}</p>
          <p class="hint">{t.rememberHint}</p>
          {/* 两个按钮一样分量，都不预选。 */}
          <div class="actions">
            <Button disabled={working} onClick={() => void state.answerRemember(true)}>
              {t.rememberAsk.yes}
            </Button>
            <Button disabled={working} onClick={() => void state.answerRemember(false)}>
              {t.rememberAsk.no}
            </Button>
          </div>
        </div>
      ) : null}
      <p class="hint">{t.hostHint}</p>

      <AdvancedBlock state={state} saved={saved} />
    </section>
  );
}
