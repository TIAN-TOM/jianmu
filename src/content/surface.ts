// 播放页上的一套界面：笔记按钮、快捷键、小窗避让和卡片。记笔记只发视频和时间点，存不存、润不润色由后台定。
import { describe, type ErrorCode } from "../core/errors.ts";
import type { AppearanceView } from "../shared/messages/core.ts";
import type { SitePage } from "../sites/page-types.ts";
import type { Surface, SurfaceEnv } from "./app.ts";
import { createCardFrame, type CardFrame } from "./card-frame.ts";
import { createMiniPlayer, type MiniPlayerDeps } from "./mini-player.ts";
import { createNoteButton, NOTE_TITLE } from "./note-button.ts";
import type { ContentRuntime } from "./runtime.ts";
import { listenShortcut } from "./shortcut.ts";

export interface SurfaceDeps extends SurfaceEnv {
  readonly document: Document;
  readonly page: SitePage;
  readonly runtime: ContentRuntime;
  readonly cardPath: string;
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

export function createSurface({ document, page, runtime, player, retire, cardPath, miniPlayer, shadowRootOf }: SurfaceDeps): Surface {
  let retired = false;
  let saving = false;
  let card: CardFrame | null = null;
  let cardEnabled = false;

  const button = createNoteButton({ document, anchor: () => page.hoverIconAnchor(), onPress: () => void saveNote() });
  const mini = createMiniPlayer({ document, overlay: () => button.overlay(), ...miniPlayer });
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
    if (!cardEnabled || retired || !player.currentKey()) {
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
      button.ensure();
      mini.sync();
      try {
        syncCard();
      } catch {
        // 卡片出问题不能连累笔记按钮的自查。
      }
    },
    videoChanged() {
      card?.videoChanged();
    },
    setAppearance(view: AppearanceView) {
      button.setAccent(view.accentTheme);
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
      mini.stop();
      card?.remove();
      card = null;
      button.remove();
    },
  };
}
