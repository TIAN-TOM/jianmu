// 设置页「速读和精读」一节：说明打开视频时怎么定模式，能清掉记住的频道偏好。清掉以后同一频道的视频回到按时长定。
import { useId, useState } from "preact/hooks";
import type { PageApi } from "../shared/api.ts";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { Status } from "./state.ts";
import { optionsText } from "./text.ts";

export function ModeSection({ api }: { readonly api: Pick<PageApi, "send"> }) {
  const t = optionsText().modes;
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const clear = async (): Promise<void> => {
    const reply = await api.send("channels.clear", {});
    setStatus(reply.ok ? { text: t.cleared, tone: "ok" } : { text: t.clearFailed, tone: "error" });
  };
  return (
    <section class="card" id="modes" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      <Confirmable label={t.clear} question={t.clearQuestion} confirmLabel={t.clearConfirm} onConfirm={() => void clear()} />
      <StatusLine status={status} />
    </section>
  );
}
