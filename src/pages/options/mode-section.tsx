// 设置页「速览和精读」一节：说明打开视频时怎么定模式，能清掉记住的频道偏好。清掉以后同一频道的视频回到按时长定。
import { useId, useState } from "preact/hooks";
import type { PageApi } from "../shared/api.ts";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { Status } from "./state.ts";

export function ModeSection({ api }: { readonly api: Pick<PageApi, "send"> }) {
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const clear = async (): Promise<void> => {
    const reply = await api.send("channels.clear", {});
    setStatus(reply.ok ? { text: "已清除，之后打开视频按时长进速览或精读。", tone: "ok" } : { text: "没能清除，请稍后再试。", tone: "error" });
  };
  return (
    <section class="card" id="modes" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>速览和精读</h2>
      <p class="hint">
        打开视频时，先看这次手动选过的模式，再看你给这个 UP 主选过的，都没有就按时长：不到 5 分钟进精读，其余进速览。在侧边栏顶上主动切换一次，就记住这个 UP 主。长视频在速览里连续播满 1 分钟会切到精读，可以撤销。
      </p>
      <Confirmable label="清除记住的 UP 主" question="清除以后，这些 UP 主的视频回到按时长选模式。" confirmLabel="清除" onConfirm={() => void clear()} />
      <StatusLine status={status} />
    </section>
  );
}
