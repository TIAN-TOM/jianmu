// 设置页「打开就出结论」一节：开关和时长门槛。打开要先同意含自动发送的数据说明，没同意时就地列出说明，
// 「同意并打开」一步做完；关掉、改时长不用同意。因为额度用完、密钥被拒、本机服务拒绝停着时，开关下面写一行原因，
// 旁边给「恢复」：点了接着做，不用关掉再打开。
import { useEffect, useId, useState } from "preact/hooks";
import { describe } from "../../core/errors.ts";
import type { AutoPauseReason } from "../../shared/messages/ai.ts";
import { AUTO_OVERVIEW_MINUTES } from "../../shared/settings-schema.ts";
import { dataConsentStatus } from "../../shared/consent-status.ts";
import { Button } from "../shared/ui/button.tsx";
import { autoMinutesHint, settleAutoMinutes } from "./auto-minutes.ts";
import { ConsentLines } from "./ai-section.tsx";
import { StatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";
import type { PageApi } from "../shared/api.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { optionsText } from "./text.ts";

/** 打开就出结论停着的原因：打开设置页时问一次，之后跟着 auto.changed 换。没停着是 null。 */
function usePaused(api: Pick<PageApi, "send" | "on">): AutoPauseReason | null {
  const [paused, setPaused] = useState<AutoPauseReason | null>(null);
  useEffect(() => {
    let alive = true;
    void api.send("config.check", {}).then((reply) => {
      if (alive && reply.ok) setPaused(reply.value.autoPaused ?? null);
    });
    const off = api.on("auto.changed", (message) => setPaused(message.paused));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return paused;
}

function PausedLine({ api, reason }: { readonly api: Pick<PageApi, "send" | "on">; readonly reason: AutoPauseReason }) {
  const words = sharedText().autoPaused;
  const [failed, setFailed] = useState("");
  const resume = async (): Promise<void> => {
    const reply = await api.send("auto.resume", {});
    setFailed(reply.ok ? "" : describe(reply.code, reply.detail, uiLang.peek()));
  };
  return (
    <>
      <div class="actions auto-paused">
        <p class="status" data-tone="warn">
          {words.reasons[reason]}
        </p>
        <Button onClick={() => void resume()}>{words.resume}</Button>
      </div>
      {failed ? <StatusLine status={{ text: failed, tone: "error" }} /> : null}
    </>
  );
}

export function AutoSection({ state, api }: { readonly state: OptionsState; readonly api: Pick<PageApi, "send" | "on"> }) {
  const t = optionsText().auto;
  const saved = state.saved.value;
  const paused = usePaused(api);
  const [asking, setAsking] = useState(false);
  // 填的数被规整成另一个数时就地说一句，下一次改分钟数时换掉或消失。
  const [minutesNote, setMinutesNote] = useState<string | null>(null);
  const id = useId();
  if (!saved) return null;
  const consent = dataConsentStatus(saved);
  const showAsk = asking && consent.state === "needed" && !saved.autoOverview;
  return (
    <section class="card" id="auto-overview" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      <p class="field-hint">{t.instant}</p>
      <label class="check">
        <input
          id="autoOverview"
          type="checkbox"
          checked={saved.autoOverview}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            if (on && consent.state === "needed") {
              event.currentTarget.checked = false;
              setAsking(true);
              return;
            }
            setAsking(false);
            void state.saveInstant({ autoOverview: on });
          }}
        />
        <span>{t.toggle}</span>
      </label>
      {paused && saved.autoOverview ? <PausedLine api={api} reason={paused} /> : null}
      {showAsk ? (
        <div class="confirm" role="group" aria-label={t.askLabel}>
          <p class="confirm-question">{consent.updated ? t.askUpdated : t.ask}</p>
          <ConsentLines items={consent.items} />
          <div class="actions">
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                void state.enableAuto();
              }}
            >
              {t.agreeAndOn}
            </Button>
            <Button variant="text" onClick={() => setAsking(false)}>
              {optionsText().cancel}
            </Button>
          </div>
        </div>
      ) : null}
      <label class="field">
        <span class="field-label">{t.minutes}</span>
        <input
          class="input"
          id="autoOverviewMinutes"
          type="number"
          inputMode="numeric"
          min={AUTO_OVERVIEW_MINUTES.min}
          max={AUTO_OVERVIEW_MINUTES.max}
          step={1}
          value={saved.autoOverviewMinutes}
          onChange={(event) => {
            const input = event.currentTarget;
            const settled = settleAutoMinutes(input.value, uiLang.value);
            setMinutesNote(settled?.note ?? null);
            if (!settled) {
              input.value = String(saved.autoOverviewMinutes);
              return;
            }
            input.value = String(settled.minutes);
            void state.saveInstant({ autoOverviewMinutes: settled.minutes });
          }}
        />
        <span class="field-hint">{autoMinutesHint(uiLang.value)}</span>
      </label>
      <StatusLine status={state.autoStatus.value ?? (minutesNote ? { text: minutesNote, tone: "warn" } : null)} />
    </section>
  );
}
