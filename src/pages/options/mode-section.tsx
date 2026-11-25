// 设置页「速读和精读」一节：说明打开视频时怎么定模式，写明记住了几个 UP 主或频道，能全部清掉。清掉以后同一频道的视频回到按时长定。
// 一个都没记时不摆清除按钮；数没问到时照旧摆着。
import { useEffect, useId, useState } from "preact/hooks";
import type { PageApi } from "../shared/api.ts";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { Status } from "./state.ts";
import { optionsText } from "./text.ts";

export function ModeSection({ api }: { readonly api: Pick<PageApi, "send"> }) {
  const t = optionsText().modes;
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [count, setCount] = useState<number | null>(null);
  // 设置页常开着放在一边：回到这一页时重新数一次，在侧边栏刚记住或「不记」的频道也算进来。
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void api.send("channels.count", {}).then((reply) => {
        if (alive && reply.ok) setCount(reply.value.count);
      });
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const clear = async (): Promise<void> => {
    const reply = await api.send("channels.clear", {});
    setStatus(reply.ok ? { text: t.cleared, tone: "ok" } : { text: t.clearFailed, tone: "error" });
    if (reply.ok) setCount(0);
  };
  return (
    <section class="card" id="modes" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      {count ? <p class="field-hint">{t.count(count)}</p> : null}
      {count !== 0 ? <Confirmable label={t.clear} question={t.clearQuestion} confirmLabel={t.clearConfirm} onConfirm={() => void clear()} /> : null}
      <StatusLine status={status} />
    </section>
  );
}
