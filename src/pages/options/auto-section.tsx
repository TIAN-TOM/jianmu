// 设置页「打开就出结论」一节：开关和时长门槛。打开要先同意含自动发送的数据说明，没同意时就地列出说明，
// 「同意并打开」一步做完；关掉、改时长不用同意。
import { useId, useState } from "preact/hooks";
import { AUTO_OVERVIEW_MINUTES } from "../../shared/settings-schema.ts";
import { dataConsentStatus } from "../../shared/consent-status.ts";
import { Button } from "../shared/ui/button.tsx";
import { AUTO_MINUTES_HINT, settleAutoMinutes } from "./auto-minutes.ts";
import { ConsentLines } from "./ai-section.tsx";
import { StatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";

export function AutoSection({ state }: { readonly state: OptionsState }) {
  const saved = state.saved.value;
  const [asking, setAsking] = useState(false);
  // 填的数被规整成另一个数时就地说一句，下一次改分钟数时换掉或消失。
  const [minutesNote, setMinutesNote] = useState<string | null>(null);
  const id = useId();
  if (!saved) return null;
  const consent = dataConsentStatus(saved);
  const showAsk = asking && consent.state === "needed" && !saved.autoOverview;
  return (
    <section class="card" id="auto-overview" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>打开就出结论</h2>
      <p class="hint">
        开着时，打开超过设定时长的 B 站视频会自动调用 AI 服务生成概览和一句话结论，显示在播放页卡片上。在后台打开、还没切过去看的标签页也会排队生成，打开开关时已经开着的也算，正在看的先生成。
        每个视频都花你的 API 额度，一次开的标签页越多，花得越多；同时最多生成两个，10 分钟最多 40 个。外文视频不自动翻译。
      </p>
      <p class="field-hint">改了马上生效，不用点「保存并授权」。</p>
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
        <span>打开视频就生成概览和结论</span>
      </label>
      {showAsk ? (
        <div class="confirm" role="group" aria-label="打开前先同意数据说明">
          <p class="confirm-question">{consent.updated ? "数据说明有更新，打开前要先同意新增的内容：" : "打开前要先同意数据说明："}</p>
          <ConsentLines items={consent.items} />
          <div class="actions">
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                void state.enableAuto();
              }}
            >
              同意并打开
            </Button>
            <Button variant="text" onClick={() => setAsking(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      <label class="field">
        <span class="field-label">超过多少分钟的视频才生成</span>
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
            const settled = settleAutoMinutes(input.value);
            setMinutesNote(settled?.note ?? null);
            if (!settled) {
              input.value = String(saved.autoOverviewMinutes);
              return;
            }
            input.value = String(settled.minutes);
            void state.saveInstant({ autoOverviewMinutes: settled.minutes });
          }}
        />
        <span class="field-hint">{AUTO_MINUTES_HINT}</span>
      </label>
      <StatusLine status={state.autoStatus.value ?? (minutesNote ? { text: minutesNote, tone: "warn" } : null)} />
    </section>
  );
}
