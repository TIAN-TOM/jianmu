// 设置页「打开就出结论」一节：开关和时长门槛。打开要先同意含自动发送的数据说明，没同意时就地列出说明，
// 「同意并打开」一步做完；关掉、改时长不用同意。
import { useId, useState } from "preact/hooks";
import { DATA_CONSENT_TABLE, noticeStatus } from "../../core/consent.ts";
import { AUTO_OVERVIEW_MINUTES } from "../../shared/settings-schema.ts";
import { Button } from "../shared/ui/button.tsx";
import { ConsentLines } from "./ai-section.tsx";
import { StatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";

export function AutoSection({ state }: { readonly state: OptionsState }) {
  const saved = state.saved.value;
  const [asking, setAsking] = useState(false);
  const id = useId();
  if (!saved) return null;
  const consent = noticeStatus(DATA_CONSENT_TABLE, { version: saved.dataConsentVersion, fingerprint: saved.dataConsentFingerprint });
  const showAsk = asking && consent.state === "needed" && !saved.autoOverview;
  return (
    <section class="card" id="auto-overview" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>打开就出结论</h2>
      <p class="hint">
        开着时，打开超过设定时长的 B 站视频会自动调用 AI 服务生成概览和一句话结论，显示在播放页卡片上。在后台打开、还没切过去看的标签页也会排队生成，正在看的先生成。每个视频都花你的 API
        额度，一次开的标签页越多，花得越多；同时只生成一个，10 分钟最多 20 个。外文视频不自动翻译。
      </p>
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
            if (input.value.trim() === "") {
              input.value = String(saved.autoOverviewMinutes);
              return;
            }
            void state.saveInstant({ autoOverviewMinutes: input.value });
          }}
        />
      </label>
      <StatusLine status={state.autoStatus.value} />
    </section>
  );
}
