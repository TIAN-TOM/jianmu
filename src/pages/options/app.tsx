// 设置页。确认启用之前只显示启用说明，和确认前就允许的导出备份、清除本机数据；确认之后才有 AI 服务、YouTube、打开就出结论、速读和精读、播放页卡片和外观（要先设置好才能用的排在前面）。「关于」一节启用前后都有。
// 状态和动作都在 state.ts，这里只渲染。文字取自文案表（text.ts），跟着界面语言重画。
import { useId, useRef, useState } from "preact/hooks";
import type { ClearScope } from "../../core/clear-guard.ts";
import { ACTIVATION_TABLE, noticeLines, noticeStatus, type ActivationKind, type NoticeItem } from "../../core/consent.ts";
import { describe } from "../../core/errors.ts";
import { LANGUAGE_SETTINGS, type LanguageSetting } from "../../core/output-lang.ts";
import { ACCENT_THEMES, THEME_MODES, UI_FONT_SCALES, type AccentTheme } from "../../shared/settings-schema.ts";
import type { Activation } from "../shared/activation.ts";
import { ActivationNotice } from "../shared/ui/activation-notice.tsx";
import { activationSections } from "../shared/ui/activation.ts";
import { Button } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { stateCopy } from "../shared/ui/state.ts";
import type { PageApi } from "../shared/api.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { AboutSection } from "./about-section.tsx";
import { AiSection } from "./ai-section.tsx";
import { AutoSection } from "./auto-section.tsx";
import { HANT_LANGUAGE_NAME } from "./language-name-hant.ts";
import { ModeSection } from "./mode-section.tsx";
import { YoutubeSection } from "./youtube-section.tsx";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";
import { optionsText } from "./text.ts";

// ---- 首次启用 ----

// 在渲染里调用：读界面语言，语言变了跟着重画。
const sectionsOf = (items: readonly NoticeItem<ActivationKind>[]) => activationSections(noticeLines(items, uiLang.value), uiLang.value);
const FULL_ACTIVATION = noticeStatus(ACTIVATION_TABLE, {});
const FULL_ACTIVATION_ITEMS = FULL_ACTIVATION.state === "needed" ? FULL_ACTIVATION.items : [];

function ActivationGate({ activation }: { readonly activation: Activation }) {
  const t = optionsText();
  const view = activation.view.value;
  if (view.state === "loading") return <p class="hint">{t.activationLoading}</p>;
  if (view.state === "failed") {
    return <StateBlock {...stateCopy(view.failure.code, view.failure.detail, uiLang.value)} primary={{ label: t.retry, onClick: () => void activation.load() }} />;
  }
  if (view.state !== "needed") return null;
  const failure = activation.confirmFailure.value;
  return (
    <section class="card">
      <ActivationNotice
        updated={view.updated}
        sections={sectionsOf(view.items)}
        fullSections={sectionsOf(FULL_ACTIVATION_ITEMS)}
        phase={activation.phase.value}
        {...(failure ? { error: describe(failure.code, failure.detail, uiLang.value) } : {})}
        onConfirm={() => void activation.confirm()}
      />
    </section>
  );
}

// ---- 外观和播放页 ----

// 三种语言各用自己的语言写，三种界面下都一样，看不懂当前界面的人也认得出；「跟随浏览器」跟着界面语言。
const LANGUAGE_NAMES: Readonly<Record<Exclude<LanguageSetting, "auto">, string>> = { zh: "简体中文", "zh-Hant": HANT_LANGUAGE_NAME, en: "English" };

const languageLabel = (language: LanguageSetting, followBrowser: string): string =>
  language === "auto" ? followBrowser : LANGUAGE_NAMES[language];

function AppearanceSection({ state }: { readonly state: OptionsState }) {
  const t = optionsText().appearance;
  const saved = state.saved.value;
  const id = useId();
  if (!saved) return null;
  return (
    <section class="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <div class="field">
        <span class="field-label" id={`${id}-theme`}>
          {t.theme}
        </span>
        <div class="theme-picker" role="radiogroup" aria-labelledby={`${id}-theme`}>
          {(Object.keys(ACCENT_THEMES) as AccentTheme[]).map((theme) => (
            <label key={theme} class="theme-option" data-theme={theme}>
              <input
                type="radio"
                name="accentTheme"
                value={theme}
                checked={saved.accentTheme === theme}
                onChange={() => void state.saveInstant({ accentTheme: theme })}
              />
              <span class="theme-swatch" style={{ background: ACCENT_THEMES[theme].swatch }} aria-hidden="true" />
              <span class="theme-text">
                <span class="theme-name">{t.themes[theme].name}</span>
                <span class="field-hint">{t.themes[theme].note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <label class="field">
        <span class="field-label">{t.mode}</span>
        <select class="input" id="themeMode" value={saved.themeMode} onChange={(event) => void state.saveInstant({ themeMode: event.currentTarget.value })}>
          {Object.values(THEME_MODES).map((mode) => (
            <option key={mode} value={mode}>
              {t.modes[mode]}
            </option>
          ))}
        </select>
        <span class="field-hint">{t.modeHint}</span>
      </label>
      <label class="field">
        <span class="field-label">{t.fontSize}</span>
        <select class="input" id="uiFontScale" value={String(saved.uiFontScale)} onChange={(event) => void state.saveInstant({ uiFontScale: Number(event.currentTarget.value) })}>
          {UI_FONT_SCALES.map((scale) => (
            <option key={scale} value={String(scale)}>
              {t.fontSizes[scale]}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="field-label">{t.language}</span>
        <select class="input" id="language" value={saved.language} onChange={(event) => void state.saveInstant({ language: event.currentTarget.value })}>
          {LANGUAGE_SETTINGS.map((language) => (
            <option key={language} value={language}>
              {languageLabel(language, t.followBrowser)}
            </option>
          ))}
        </select>
        <span class="field-hint">{t.languageHint}</span>
      </label>
    </section>
  );
}

function CardSection({ state }: { readonly state: OptionsState }) {
  const t = optionsText().card;
  const saved = state.saved.value;
  if (!saved) return null;
  return (
    <section class="card">
      <h2>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      <label class="check">
        <input id="inPageCard" type="checkbox" checked={saved.inPageCard} onChange={(event) => void state.saveInstant({ inPageCard: event.currentTarget.checked })} />
        <span>{t.toggle}</span>
      </label>
    </section>
  );
}

// ---- 稍后再看粗筛 ----

function TriageSection() {
  const t = optionsText().triage;
  return (
    <section class="card" id="triage-entry">
      <h2>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      <div class="actions">
        <a class="button" data-variant="secondary" id="openTriage" href="./triage.html" target="_blank" rel="noopener">
          {t.open}
        </a>
      </div>
    </section>
  );
}

// ---- 资料 ----

function DataSection({ state, enabled }: { readonly state: OptionsState; readonly enabled: boolean }) {
  const t = optionsText().data;
  const file = useRef<HTMLInputElement>(null);
  const busy = state.busy.value;
  const working = busy !== null;
  // 三个清除按钮同一时间只开一个确认框，免得一个收回后下面的上移，连点落到另一个的「确认」上。
  const [asking, setAsking] = useState<ClearScope | null>(null);
  const confirmFor = (scope: ClearScope) => ({
    open: asking === scope,
    onOpenChange: (open: boolean) => setAsking(open ? scope : null),
    disabled: working,
    onConfirm: () => void state.clearData(scope),
  });
  return (
    <section class="card" id="learning-data">
      <h2>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      <div class="actions">
        <Button disabled={working} onClick={() => void state.exportBackup()}>
          {busy === "export" ? t.exporting : t.export}
        </Button>
        {enabled ? (
          <>
            <Button disabled={working} onClick={() => file.current?.click()}>
              {busy === "import" ? t.importing : t.import}
            </Button>
            <input
              ref={file}
              id="backupImportInput"
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const input = event.currentTarget;
                const chosen = input.files?.[0];
                input.value = "";
                if (chosen) await state.importBackup(() => chosen.text());
              }}
            />
          </>
        ) : null}
      </div>

      <h3 class="subhead">{t.clearTitle}</h3>
      <p class="hint">{t.clearHint}</p>
      <div class="actions">
        <Confirmable
          label={t.clearCache}
          question={t.clearCacheQuestion}
          confirmLabel={t.clearCacheConfirm}
          {...confirmFor("cache")}
        />
        <Confirmable
          label={t.clearNotes}
          question={t.clearNotesQuestion}
          confirmLabel={t.clearNotesConfirm}
          danger
          {...confirmFor("notes")}
        />
        <Confirmable
          label={t.clearAll}
          question={t.clearAllQuestion}
          confirmLabel={t.clearAllConfirm}
          danger
          {...confirmFor("all")}
        />
      </div>
      <StatusLine status={state.dataStatus.value} />
    </section>
  );
}

// 关掉 YouTube 开关的构建里这一节连同授权代码一起裁掉。
const SiteSections = FEATURE_YOUTUBE ? YoutubeSection : null;

export function App({
  state,
  activation,
  api,
  version,
}: {
  readonly state: OptionsState;
  readonly activation: Activation;
  readonly api: Pick<PageApi, "send" | "on">;
  readonly version: string;
}) {
  const t = optionsText();
  const enabled = activation.enabled.value;
  const loadError = state.loadError.value;
  return (
    <main class="page">
      <h1>{t.title}</h1>
      <ActivationGate activation={activation} />
      {loadError ? <StateBlock title={t.loadFailed} impact={loadError} primary={{ label: t.retry, onClick: () => void state.load() }} /> : null}
      {enabled ? (
        <>
          {/* 要先设置好才能用的排在前面：AI 服务、YouTube；常调的开关其次；外观最少动，放在后面。 */}
          <AiSection state={state} />
          {SiteSections ? <SiteSections /> : null}
          <AutoSection state={state} api={api} />
          <ModeSection api={api} />
          <CardSection state={state} />
          <AppearanceSection state={state} />
          <TriageSection />
        </>
      ) : null}
      <DataSection state={state} enabled={enabled} />
      <AboutSection version={version} />
    </main>
  );
}
