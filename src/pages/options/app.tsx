// 设置页。确认启用之前只显示启用说明，和确认前就允许的导出备份、清除本机数据；确认之后才有外观、播放页卡片和 AI 服务。
// 状态和动作都在 state.ts，这里只渲染。
import { useId, useRef } from "preact/hooks";
import { ACTIVATION_TABLE, noticeLines, noticeStatus, type ActivationKind, type NoticeItem } from "../../core/consent.ts";
import { describe } from "../../core/errors.ts";
import { ACCENT_THEMES, THEME_MODES, UI_FONT_SCALES, type AccentTheme, type ThemeMode } from "../../shared/settings-schema.ts";
import type { Activation } from "../shared/activation.ts";
import { ActivationNotice } from "../shared/ui/activation-notice.tsx";
import { activationSections } from "../shared/ui/activation.ts";
import { Button } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { AiSection } from "./ai-section.tsx";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";

// ---- 首次启用 ----

const sectionsOf = (items: readonly NoticeItem<ActivationKind>[]) => activationSections(noticeLines(items));
const FULL_ACTIVATION = noticeStatus(ACTIVATION_TABLE, {});
const FULL_ACTIVATION_ITEMS = FULL_ACTIVATION.state === "needed" ? FULL_ACTIVATION.items : [];

function ActivationGate({ activation }: { readonly activation: Activation }) {
  const view = activation.view.value;
  if (view.state === "loading") return <p class="hint">正在读取启用状态……</p>;
  if (view.state === "failed") {
    return <StateBlock title="读不到启用状态" impact={describe(view.failure.code, view.failure.detail)} primary={{ label: "重试", onClick: () => void activation.load() }} />;
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
        {...(failure ? { error: describe(failure.code, failure.detail) } : {})}
        onConfirm={() => void activation.confirm()}
      />
    </section>
  );
}

// ---- 外观和播放页 ----

const FONT_LABELS: Readonly<Record<number, string>> = { 100: "标准", 112: "较大", 125: "特大" };
const MODE_LABELS: Readonly<Record<ThemeMode, string>> = { system: "跟随系统", light: "浅色", dark: "深色" };

function AppearanceSection({ state }: { readonly state: OptionsState }) {
  const saved = state.saved.value;
  const id = useId();
  if (!saved) return null;
  return (
    <section class="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>外观</h2>
      <p class="hint">只作用于这台电脑上的侧边栏、播放页卡片和本页，改了马上生效，不用点「保存并授权」。</p>
      <div class="field">
        <span class="field-label" id={`${id}-theme`}>主题</span>
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
                <span class="theme-name">{ACCENT_THEMES[theme].label}</span>
                <span class="field-hint">{ACCENT_THEMES[theme].note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <label class="field">
        <span class="field-label">明暗</span>
        <select class="input" id="themeMode" value={saved.themeMode} onChange={(event) => void state.saveInstant({ themeMode: event.currentTarget.value })}>
          {Object.values(THEME_MODES).map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="field-label">界面字号</span>
        <select class="input" id="uiFontScale" value={String(saved.uiFontScale)} onChange={(event) => void state.saveInstant({ uiFontScale: Number(event.currentTarget.value) })}>
          {UI_FONT_SCALES.map((scale) => (
            <option key={scale} value={String(scale)}>
              {FONT_LABELS[scale]}
            </option>
          ))}
        </select>
        <span class="field-hint">字幕、概览和笔记一起缩放。</span>
      </label>
    </section>
  );
}

function CardSection({ state }: { readonly state: OptionsState }) {
  const saved = state.saved.value;
  if (!saved) return null;
  return (
    <section class="card">
      <h2>播放页</h2>
      <p class="hint">
        卡片放在弹幕列表上方，显示 B 站官方总结和已经生成的概览，可以收起，也可以从它打开侧边栏。关掉以后播放页只留笔记按钮，打开侧边栏要点浏览器工具栏里的扩展图标。改了马上生效。
      </p>
      <label class="check">
        <input id="inPageCard" type="checkbox" checked={saved.inPageCard} onChange={(event) => void state.saveInstant({ inPageCard: event.currentTarget.checked })} />
        <span>在视频右侧显示总结卡片</span>
      </label>
    </section>
  );
}

// ---- 稍后再看粗筛 ----

function TriageSection() {
  return (
    <section class="card" id="triage-entry">
      <h2>稍后再看粗筛</h2>
      <p class="hint">
        在新标签页里读取你的 B 站稍后再看列表，先用官方总结快速看每个视频讲了什么，需要时再花 API 额度写一句话结论，按判断分组、导出清单。读取列表和取官方总结不调模型。
      </p>
      <div class="actions">
        <a class="button" data-variant="secondary" id="openTriage" href="./triage.html" target="_blank" rel="noopener">
          打开稍后再看粗筛
        </a>
      </div>
    </section>
  );
}

// ---- 资料 ----

function DataSection({ state, enabled }: { readonly state: OptionsState; readonly enabled: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const busy = state.busy.value;
  const working = busy !== null;
  return (
    <section class="card" id="learning-data">
      <h2>学习资料</h2>
      <p class="hint">
        笔记、概览和问答历史只存在这台电脑上，卸载扩展时由浏览器一起清掉。导出的备份含笔记、概览和问答历史，不含 API 密钥、设置和导入的字幕文件。恢复时和本机已有的合并，同一条以更新时间较新的为准，本机独有的不会删。
      </p>
      <div class="actions">
        <Button disabled={working} onClick={() => void state.exportBackup()}>
          {busy === "export" ? "正在导出" : "导出备份"}
        </Button>
        {enabled ? (
          <>
            <Button disabled={working} onClick={() => file.current?.click()}>
              {busy === "import" ? "正在恢复" : "恢复备份"}
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
                if (chosen) await state.importBackup(await chosen.text());
              }}
            />
          </>
        ) : null}
      </div>

      <h3 class="subhead">清除本机数据</h3>
      <p class="hint">
        「清除缓存」删掉字幕和视频信息的缓存，以及粗筛读到的列表；笔记、导入的字幕文件、保存的概览和问答、设置都留着。「清除全部数据」删掉简幕在这台电脑上存的一切，包括笔记、概览、问答、导入的字幕文件、设置和密钥，删了不能恢复，要留着的先导出备份。正在生成的概览和问答会先停下。
      </p>
      <div class="actions">
        <Confirmable
          label="清除缓存"
          question="清除字幕和视频信息的缓存，以及粗筛读到的列表？笔记、概览、问答和设置都留着。"
          confirmLabel="清除缓存"
          disabled={working}
          onConfirm={() => void state.clearData("cache")}
        />
        <Confirmable
          label="清除全部数据"
          question="清除简幕在这台电脑上存的全部数据？笔记、概览、问答、导入的字幕文件、缓存、设置和密钥都会删掉，删了不能恢复。"
          confirmLabel="全部清除"
          danger
          disabled={working}
          onConfirm={() => void state.clearData("all")}
        />
      </div>
      <StatusLine status={state.dataStatus.value} />
    </section>
  );
}

export function App({ state, activation }: { readonly state: OptionsState; readonly activation: Activation }) {
  const enabled = activation.enabled.value;
  const loadError = state.loadError.value;
  return (
    <main class="page">
      <h1>简幕设置</h1>
      <ActivationGate activation={activation} />
      {loadError ? <StateBlock title="读不出设置" impact={loadError} primary={{ label: "重试", onClick: () => void state.load() }} /> : null}
      {enabled ? (
        <>
          <AppearanceSection state={state} />
          <CardSection state={state} />
          <AiSection state={state} />
          <TriageSection />
        </>
      ) : null}
      <DataSection state={state} enabled={enabled} />
    </main>
  );
}
