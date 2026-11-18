// 播放页上的一套界面：悬停才露的图标（笔记，构建开关打开时还有解释当前画面）、快捷键、小窗避让和卡片。
// 记笔记只发视频和时间点，存不存、润不润色由后台定。
import { describe, type ErrorCode } from "../core/errors.ts";
import type { AppearanceView } from "../shared/messages/core.ts";
import type { SitePage } from "../sites/page-types.ts";
import type { Surface, SurfaceEnv } from "./app.ts";
import { createCardFrame, type CardFrame } from "./card-frame.ts";
import { createFramePress, frameIconEntries } from "./frame-icon.ts";
import { createHoverIcons, NOTE_ICON, NOTE_TITLE, type HoverIconEntry } from "./hover-icons.ts";
import { createMiniPlayer, type MiniPlayerDeps } from "./mini-player.ts";
import type { ContentRuntime } from "./runtime.ts";
import { listenShortcut } from "./shortcut.ts";

export interface SurfaceDeps extends SurfaceEnv {
  readonly document: Document;
  readonly page: SitePage;
  readonly runtime: ContentRuntime;
  /** 播放页卡片的页面路径；不放卡片的站不给。 */
  readonly cardPath?: string;
  readonly miniPlayer: Omit<MiniPlayerDeps, "document" | "overlay">;
  readonly shadowRootOf?: (element: Element) => ShadowRoot | null;
}

const RELOAD_HINT = "已更新，刷新页面后可用";
const RELOAD_TITLE = "简幕已更新，刷新页面后可用";
const RELOAD_HINT_MS = 4000;

// 保存失败的常见原因给个短说法，完整说明放在悬停提示里。
const SHORT_FAILURES: Partial<Record<ErrorCode, string>> = {
  NO_CAPTIONS: "无字幕",
  NEED_LOGIN: "需登录",
  STORAGE_FULL: "空间不足",
  NOT_ENABLED: "未启用",
};

export function createSurface({ document, page, runtime, player, frame, retire, cardPath, miniPlayer, shadowRootOf }: SurfaceDeps): Surface {
  let retired = false;
  let saving = false;
  let card: CardFrame | null = null;
  let cardEnabled = false;

  let pressFrame: (() => Promise<void>) | null = null;
  // 解释当前画面的图标只写在裸开关的分支里：开关关着的构建连同图标一起裁掉，不留点了没反应的按钮。
  const entries: HoverIconEntry[] = [
    { spec: NOTE_ICON, onPress: () => void saveNote() },
    ...(FEATURE_FRAME_EXPLAIN ? frameIconEntries(frame, () => void pressFrame?.()) : []),
  ];
  const icons = createHoverIcons({ document, anchor: () => page.hoverIconAnchor(), icons: entries });
  const button = icons.icon(NOTE_ICON.id) ?? { flash: () => undefined, setTitle: () => undefined };
  pressFrame = FEATURE_FRAME_EXPLAIN
    ? frame
      ? createFramePress({
          icons,
          runtime,
          currentKey: player.currentKey,
          findMainVideo: () => page.findMainVideo(),
          confirmed: player.confirmed,
          gone: () => retired || !runtime.alive(),
          onGone: () => showReloadHint(),
        })
      : null
    : null;
  const stopControls = page.watchControls?.((visible) => icons.setControls(visible)) ?? (() => undefined);
  const mini = createMiniPlayer({ document, overlay: () => icons.overlay(), ...miniPlayer });
  const stopShortcut = page.noteShortcut ? listenShortcut({ document, key: page.noteShortcut, onPress: () => void saveNote(), ...(shadowRootOf ? { shadowRootOf } : {}) }) : () => undefined;

  function showReloadHint(): void {
    retire();
    button.flash(RELOAD_HINT, RELOAD_HINT_MS);
  }

  async function saveNote(): Promise<void> {
    if (retired || !runtime.alive()) return showReloadHint();
    if (saving) return;
    const video = player.currentKey();
    const main = page.findMainVideo();
    if (!video || main.status === "none") return;
    if (main.status === "ad") return button.flash("正在播广告");
    if (!player.confirmed()) return button.flash("视频还在切换");
    // 连点几下不该存出几条一样的笔记：在途时忽略，不排队。
    saving = true;
    button.flash("保存中…", 0);
    try {
      const reply = await runtime.send("notes.saveAtTime", { video, atSec: Math.floor(main.video.currentTime || 0) });
      if (!runtime.alive()) return showReloadHint();
      if (reply.ok) {
        button.setTitle(NOTE_TITLE);
        button.flash(reply.value.duplicate ? "该时刻已有笔记" : reply.value.polishLimited ? "已保存，未润色" : "已保存");
      } else {
        button.setTitle(describe(reply.code, reply.detail));
        button.flash(SHORT_FAILURES[reply.code] ?? "保存失败");
      }
    } finally {
      saving = false;
    }
  }

  function syncCard(): void {
    if (!cardPath || !cardEnabled || retired || !player.currentKey()) {
      card?.remove();
      card = null;
      return;
    }
    card ??= createCardFrame({
      document,
      cardUrl: () => runtime.url(cardPath),
      extensionRoot: () => runtime.url(""),
      slot: () => page.cardSlot?.() ?? null,
      fillsScreen: () => page.fillsScreen?.() ?? false,
    });
    card.ensure();
  }

  return {
    tick() {
      if (retired) return;
      icons.ensure();
      mini.sync();
      try {
        syncCard();
      } catch {
        // 卡片出问题不能连累笔记图标的自查。
      }
    },
    videoChanged() {
      card?.videoChanged();
    },
    setAppearance(view: AppearanceView) {
      icons.setAccent(view.accentTheme);
      cardEnabled = view.inPageCard;
      if (!retired) syncCard();
    },
    retire() {
      retired = true;
      card?.remove();
      card = null;
      button.setTitle(RELOAD_TITLE);
    },
    remove() {
      retired = true;
      stopShortcut();
      stopControls();
      mini.stop();
      card?.remove();
      card = null;
      icons.remove();
    },
  };
}
