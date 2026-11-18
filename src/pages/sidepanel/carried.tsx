// 开发者本人的日用包：两份说明的条目变了照旧沿用，侧边栏顶上那一行说一句说明更新了；点开分两组列出这次多了什么，
// 点「知道了」记下当前这一版，这一行就不再出现。只从 FEATURE_KEEP_CONSENT 的分支引用，对外的发行包里没有这个模块。
import { signal, type Signal } from "@preact/signals";
import { noticeLines, type CarriedItems, type NoticeLine } from "../../core/consent.ts";
import { Button } from "../shared/ui/button.tsx";
import type { NoticeEntry } from "../shared/ui/notice.ts";
import type { Panel } from "./panel.ts";

interface Shown {
  readonly read: readonly NoticeLine<string>[];
  readonly send: readonly NoticeLine<string>[];
}

/**
 * 点开时把这次多出来的条目记下来：点「知道了」写入以后状态里就没有了，列表照样留着直到收起。
 * 用到时才建：模块顶层有函数调用，开关关着的构建就裁不掉这个模块。
 */
let shownLines: Signal<Shown | null> | undefined;
const shown = (): Signal<Shown | null> => (shownLines ??= signal(null));

const linesOf = (carried: CarriedItems): Shown => ({ read: noticeLines(carried.activation), send: noticeLines(carried.consent) });

export function carriedNotice(panel: Panel): NoticeEntry | null {
  const view = panel.activation.view.value;
  if (shown().value || view.state !== "current" || !view.carried) return null;
  const carried = view.carried;
  return {
    id: "carried",
    priority: 3.5,
    text: "说明更新了，多了几项，照旧在用",
    tone: "plain",
    action: { label: "看看多了什么", run: () => void (shown().value = linesOf(carried)) },
  };
}

function Group({ title, lines }: { readonly title: string; readonly lines: readonly NoticeLine<string>[] }) {
  if (!lines.length) return null;
  return (
    <>
      <p class="carried-title">{title}</p>
      <ul class="activation-lines">
        {lines.map((line) => (
          <li key={line.ids.join()}>{line.text}</li>
        ))}
      </ul>
    </>
  );
}

export function CarriedList({ panel }: { readonly panel: Panel }) {
  const lines = shown().value;
  if (!lines) return null;
  return (
    <section class="carried" aria-label="说明新增的内容">
      <Group title="在本机多读的" lines={lines.read} />
      <Group title="多发给模型服务的" lines={lines.send} />
      <Button
        onClick={() => {
          shown().value = null;
          void panel.activation.acknowledge();
        }}
      >
        知道了
      </Button>
    </section>
  );
}
