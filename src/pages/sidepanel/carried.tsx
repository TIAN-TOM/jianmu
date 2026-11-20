// 开发者本人的日用包：两份说明的条目变了照旧沿用，侧边栏顶上那一行说一句说明更新了；点开分两组列出这次多了什么，
// 点「知道了」记下当前这一版，这一行就不再出现。只从 FEATURE_KEEP_CONSENT 的分支引用，对外的发行包里没有这个模块。
import type { VNode } from "preact";
import { signal, type Signal } from "@preact/signals";
import { noticeLines, type CarriedItems, type NoticeLine } from "../../core/consent.ts";
import { Button } from "../shared/ui/button.tsx";
import type { NoticeEntry } from "../shared/ui/notice.ts";
import { uiLang } from "../shared/ui-lang.ts";
import type { Panel } from "./panel.ts";

const CARRIED_ZH = {
  notice: "说明更新了，多了几项，照旧在用",
  show: "看看多了什么",
  label: "说明新增的内容",
  read: "在本机多读的",
  send: "多发给模型服务的",
  done: "知道了",
};

const CARRIED_EN: typeof CARRIED_ZH = {
  notice: "The notices were updated with a few new items. Jianmu keeps working as before",
  show: "See what's new",
  label: "What's new in the notices",
  read: "Also read on this computer",
  send: "Also sent to the model service",
  done: "Got it",
};

const carriedText = (): typeof CARRIED_ZH => (uiLang.value === "en" ? CARRIED_EN : CARRIED_ZH);

type Shown = CarriedItems;

/**
 * 点开时把这次多出来的条目记下来（排成行在渲染时做）：点「知道了」写入以后状态里就没有了，列表照样留着直到收起。
 * 用到时才建：模块顶层有函数调用，开关关着的构建就裁不掉这个模块。
 */
let shownLines: Signal<Shown | null> | undefined;
const shown = (): Signal<Shown | null> => (shownLines ??= signal(null));


export function carriedNotice(panel: Panel): NoticeEntry | null {
  const view = panel.activation.view.value;
  if (shown().value || view.state !== "current" || !view.carried) return null;
  const carried = view.carried;
  const t = carriedText();
  return {
    id: "carried",
    priority: 3.5,
    text: t.notice,
    tone: "plain",
    action: { label: t.show, run: () => void (shown().value = carried) },
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

function CarriedList({ panel }: { readonly panel: Panel }) {
  const carried = shown().value;
  if (!carried) return null;
  const t = carriedText();
  // 条目在渲染时按界面语言排成行，语言变了跟着换。
  const lang = uiLang.value;
  return (
    <section class="carried" aria-label={t.label}>
      <Group title={t.read} lines={noticeLines(carried.activation, lang)} />
      <Group title={t.send} lines={noticeLines(carried.consent, lang)} />
      <Button
        onClick={() => {
          shown().value = null;
          void panel.activation.acknowledge();
        }}
      >
        {t.done}
      </Button>
    </section>
  );
}

/** 开关分支里只写这个名字：JSX 留在这个模块里，开关关着的构建连它一起裁掉。 */
export function carriedList(panel: Panel): VNode {
  return <CarriedList panel={panel} />;
}
