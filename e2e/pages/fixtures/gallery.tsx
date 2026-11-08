// 组件样张：页面测试时现编进测试用的扩展副本，不进产品包。数据都是自造的。
// 每一块有自己的 id，页面测试只看 DOM 文字和属性。
import { signal } from "@preact/signals";
import { render } from "preact";
import { ACTIVATION_TABLE, noticeStatus } from "../../../src/core/consent.ts";
import type { Mode } from "../../../src/core/mode/types.ts";
import { ActivationNotice } from "../../../src/pages/shared/ui/activation-notice.tsx";
import { activationSections } from "../../../src/pages/shared/ui/activation.ts";
import { Badge, Button, IconButton } from "../../../src/pages/shared/ui/button.tsx";
import { ChapterList } from "../../../src/pages/shared/ui/chapter-list.tsx";
import { Dock } from "../../../src/pages/shared/ui/dock.tsx";
import { VerdictMark } from "../../../src/pages/shared/ui/icon.tsx";
import { Menu } from "../../../src/pages/shared/ui/menu.tsx";
import { ModeSwitch } from "../../../src/pages/shared/ui/mode-switch.tsx";
import { Notice } from "../../../src/pages/shared/ui/notice.tsx";
import type { NoticeEntry } from "../../../src/pages/shared/ui/notice.ts";
import { Layer, Sheet } from "../../../src/pages/shared/ui/overlay.tsx";
import { StateBlock } from "../../../src/pages/shared/ui/state-block.tsx";
import { stateCopy } from "../../../src/pages/shared/ui/state.ts";
import { TimeRail } from "../../../src/pages/shared/ui/time-rail.tsx";
import { VerdictBlock } from "../../../src/pages/shared/ui/verdict-block.tsx";
import { MARK_SHAPES } from "../../../src/pages/shared/ui/verdict.ts";

const DURATION_SEC = 600;
const CHAPTERS = [
  { startSec: 0, title: "样例开场：先说结论" },
  { startSec: 120, title: "样例第一部分：背景和问题" },
  { startSec: 300, title: "样例第二部分：一个很长很长的章节名，用来看窄宽度下会不会把页面撑出横向滚动条" },
  { startSec: 540, title: "样例收尾" },
];
const KEY_STARTS = [120, 540];
const POSITION_SEC = 210;
const BLOCKS = [
  { startSec: 0, endSec: 200, state: "done" as const },
  { startSec: 200, endSec: 400, state: "writing" as const },
  { startSec: 400, endSec: 500, state: "failed" as const },
  { startSec: 500, endSec: 600, state: "pending" as const },
];

const mode = signal<Mode>("skim");
const focus = signal<number | null>(null);
const expanded = signal<readonly number[]>([1]);
const seeks = signal<readonly number[]>([]);
const sheetOpen = signal(false);
const sheetMounted = signal(true);
const layerOpen = signal(false);
const picked = signal("");
const confirms = signal(0);
const dropTop = signal(false);

const seek = (startSec: number): void => {
  seeks.value = [...seeks.value, startSec];
};
const toggle = (index: number): void => {
  expanded.value = expanded.value.includes(index) ? expanded.value.filter((item) => item !== index) : [...expanded.value, index];
};

function RailDemo({ id, keyStarts }: { readonly id: string; readonly keyStarts?: readonly number[] }) {
  return (
    <section id={id} class="gallery-rail-row">
      <TimeRail durationSec={DURATION_SEC} chapters={CHAPTERS} keyStarts={keyStarts} positionSec={POSITION_SEC} focusIndex={focus.value} onSeek={seek} onHover={(index) => (focus.value = index)} />
      <div class="gallery-grow">
        <ChapterList
          chapters={CHAPTERS}
          keyStarts={keyStarts}
          expanded={expanded.value}
          onToggle={toggle}
          onSeek={seek}
          focusIndex={focus.value}
          onHover={(index) => (focus.value = index)}
          renderDetail={(chapter) => <p class="gallery-detail">这一章的要点（自造）：{chapter.title}</p>}
        />
      </div>
    </section>
  );
}

const NOTICES: readonly NoticeEntry[] = [
  { id: "remembered", priority: 6, text: "已记住：示例作者的视频以后先进精读", tone: "plain" },
  { id: "consent", priority: 1, text: "数据说明更新了，重新同意后才能用 AI 功能", tone: "warn", action: { label: "去看看", run: () => (picked.value = "去看看") } },
  { id: "batch", priority: 7, text: "本窗口全部生成：完成 2 个，共 5 个", tone: "plain" },
];

const fullStatus = noticeStatus(ACTIVATION_TABLE, {});
const FULL_SECTIONS = activationSections(fullStatus.state === "needed" ? fullStatus.items : []);
const NEW_SECTIONS = activationSections([{ kind: "read", text: "示例：说明新增的一项读取" }]);
const noCaptions = stateCopy("NO_CAPTIONS");

function Gallery() {
  return (
    <main class="gallery">
      <h1 class="gallery-title">组件样张</h1>

      <section id="notice-demo">
        <Notice notices={dropTop.value ? NOTICES.filter((notice) => notice.id !== "consent") : NOTICES} />
        <button type="button" id="notice-drop-top" onClick={() => (dropTop.value = true)}>
          去掉最优先的一条
        </button>
      </section>

      <section id="modes-demo">
        <ModeSwitch value={mode.value} onChange={(next) => (mode.value = next)} />
        <p id="mode-value">{mode.value}</p>
      </section>

      <RailDemo id="rail-key" keyStarts={KEY_STARTS} />
      <RailDemo id="rail-plain" />
      <p id="seek-result">{seeks.value.join(",")}</p>

      <section id="rail-blocks" class="gallery-rail-row">
        <TimeRail durationSec={DURATION_SEC} blocks={BLOCKS} keyStarts={KEY_STARTS} positionSec={POSITION_SEC} />
      </section>

      <section id="rail-horizontal">
        <TimeRail orientation="horizontal" durationSec={DURATION_SEC} chapters={CHAPTERS} keyStarts={KEY_STARTS} positionSec={POSITION_SEC} />
      </section>

      <section id="marks">
        {MARK_SHAPES.map((shape) => (
          <span key={shape} class="gallery-mark">
            <VerdictMark shape={shape} />
            <span>{shape}</span>
          </span>
        ))}
      </section>

      <section id="verdicts" class="gallery-stack">
        <VerdictBlock label="值得看完整视频" text="样例结论：讲清了问题的来龙去脉，值得从头看。" basis="transcript" menu={<Menu label="更多操作" items={[{ label: "重新生成", hint: "会再调一次模型", onSelect: () => (picked.value = "重新生成") }]} />} />
        <VerdictBlock label="看概览就够" text="样例结论：要点都在章节里，看概览就够。" basis="official-summary" />
        <VerdictBlock label="可以跳过" text="样例结论：和标题关系不大，可以跳过。" basis="title-description" staleTranscript />
        <VerdictBlock label="信息不足" text="样例结论：字幕只覆盖了一部分，判断不了。" basis="legacy-unknown" incomplete />
        <VerdictBlock label="还行" text="样例结论：档位认不出来时只写结论句。" />
      </section>

      <section id="state-demo">
        <StateBlock
          title={noCaptions.title}
          impact="读不到字幕，生成不了完整概览。可以导入字幕文件。"
          primary={{ label: "导入字幕文件", onClick: () => (picked.value = "导入字幕文件") }}
          secondary={[
            { label: "只用标题和简介写结论", onClick: () => (picked.value = "只用标题和简介写结论"), note: "会调用一次模型" },
            { label: "重新读取", onClick: () => (picked.value = "重新读取") },
          ]}
        />
      </section>

      <section id="controls" class="gallery-wrap">
        <Button variant="primary">生成概览</Button>
        <Button>重新读取</Button>
        <Button variant="text">查看完整说明</Button>
        <Button variant="danger">清除全部数据</Button>
        <Button disabled disabledReason="先启用简幕">测试连接</Button>
        <IconButton icon="note" label="存笔记" />
        <Badge tone="warn">没润色</Badge>
        <Badge tone="line">基于旧字幕</Badge>
        <Badge tone="ok">已保存</Badge>
      </section>

      <section id="overlays" class="gallery-wrap">
        <button type="button" id="open-sheet" onClick={() => (sheetOpen.value = true)}>
          打开抽屉
        </button>
        <button type="button" id="open-layer" onClick={() => (layerOpen.value = true)}>
          打开层
        </button>
        <span id="menu-demo">
          <Menu
            label="任务"
            icon="task"
            text="任务"
            items={[
              { label: "停止这一项", onSelect: () => (picked.value = "停止这一项") },
              { label: "全部停止", hint: "已经发出的请求可能已经计费", danger: true, onSelect: () => (picked.value = "全部停止") },
              { label: "暂时不能用", disabled: true, onSelect: () => (picked.value = "暂时不能用") },
            ]}
          />
        </span>
        <p id="picked">{picked.value}</p>
      </section>

      {sheetMounted.value ? (
        <Sheet open={sheetOpen.value} title="问答" onClose={() => (sheetOpen.value = false)}>
          <p>抽屉里的样例内容。</p>
          <button type="button" id="sheet-inner">
            抽屉里的按钮
          </button>
        </Sheet>
      ) : null}
      <Layer open={layerOpen.value} title="笔记" onClose={() => (layerOpen.value = false)}>
        <p>层里的样例内容。</p>
      </Layer>

      <section id="activation-fresh">
        <ActivationNotice updated={false} sections={FULL_SECTIONS} phase="idle" onConfirm={() => (confirms.value += 1)} />
        <p id="activation-confirms">{confirms.value}</p>
      </section>
      <section id="activation-updated">
        <ActivationNotice updated sections={NEW_SECTIONS} fullSections={FULL_SECTIONS} phase="idle" onConfirm={() => {}} />
      </section>
      <section id="activation-saving">
        <ActivationNotice updated={false} sections={NEW_SECTIONS} phase="saving" onConfirm={() => {}} />
      </section>
      <section id="activation-failed">
        <ActivationNotice updated={false} sections={NEW_SECTIONS} phase="failed" error="样例原因：设置没写进去，再点一次试试。" onConfirm={() => {}} />
      </section>

      <Dock>
        <input class="gallery-grow" aria-label="提问" placeholder="问这个视频" />
        <Button>本窗口全部生成</Button>
      </Dock>
    </main>
  );
}

// 测试用的开关：抽屉开着时把整个组件拿掉。
Object.assign(window, {
  galleryControls: {
    unmountSheet: () => (sheetMounted.value = false),
    mountSheet: () => {
      sheetOpen.value = false;
      sheetMounted.value = true;
    },
  },
});

const root = document.getElementById("app");
if (root) render(<Gallery />, root);
