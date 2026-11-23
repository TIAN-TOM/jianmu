// 播放页上的一套界面：悬停才露的图标（笔记，构建开关打开时还有解释当前画面）、快捷键、小窗避让和卡片。
// 记笔记只发视频和时间点，存不存、润不润色由后台定。
import { describe, type ErrorCode } from "../core/errors.ts";
import type { AppearanceView } from "../shared/messages/core.ts";
import type { SitePage } from "../sites/page-types.ts";
import type { Surface, SurfaceEnv } from "./app.ts";
import { createCardFrame, type CardFrame } from "./card-frame.ts";
import { createFramePress, frameIconEntries, retitleFrameIcon } from "./frame-icon.ts";
import { createHoverIcons, NOTE_ICON, noteIcon, type HoverIconEntry } from "./hover-icons.ts";
import { createContentLang, pageUiLanguage } from "./lang.ts";
import { createMiniPlayer, type MiniPlayerDeps } from "./mini-player.ts";
import { pageTone } from "./page-tone.ts";
import { noteTimestamp } from "./player.ts";
import type { ContentRuntime } from "./runtime.ts";
import { listenShortcut } from "./shortcut.ts";
import { contentText } from "./text.ts";

export interface SurfaceDeps extends SurfaceEnv {
  readonly document: Document;
  readonly page: SitePage;
  readonly runtime: ContentRuntime;
  /** 播放页卡片的页面路径；不放卡片的站不给。 */
  readonly cardPath?: string;
  readonly miniPlayer: Omit<MiniPlayerDeps, "document" | "overlay">;
  readonly shadowRootOf?: (element: Element) => ShadowRoot | null;
  /** 浏览器的界面语言，语言选项是跟随浏览器时按它定；不给时读浏览器的。 */
  readonly uiLanguage?: () => string;
}

const RELOAD_HINT_MS = 4000;

export function createSurface({ document, page, runtime, player, frame, retire, cardPath, miniPlayer, shadowRootOf, uiLanguage = pageUiLanguage }: SurfaceDeps): Surface {
  const lang = createContentLang(uiLanguage);
  const text = () => contentText(lang.current());
  let retired = false;
  let saving = false;
  let card: CardFrame | null = null;
  let cardEnabled = false;

  let pressFrame: (() => Promise<void>) | null = null;
  // 解释当前画面的图标只写在裸开关的分支里：开关关着的构建连同图标一起裁掉，不留点了没反应的按钮。
  const entries: HoverIconEntry[] = [
    { spec: noteIcon(lang.current()), onPress: () => void saveNote() },
    ...(FEATURE_FRAME_EXPLAIN ? frameIconEntries(frame, () => void pressFrame?.(), lang.current()) : []),
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
          lang: lang.current,
        })
      : null
    : null;
  const stopControls = page.watchControls?.((visible) => icons.setControls(visible)) ?? (() => undefined);
  const mini = createMiniPlayer({ document, overlay: () => icons.overlay(), ...miniPlayer });
  const stopShortcut = page.noteShortcut ? listenShortcut({ document, key: page.noteShortcut, onPress: () => void saveNote(), ...(shadowRootOf ? { shadowRootOf } : {}) }) : () => undefined;

  function showReloadHint(): void {
    retire();
    button.flash(text().reloadHint, RELOAD_HINT_MS);
  }

  async function saveNote(): Promise<void> {
    if (retired || !runtime.alive()) return showReloadHint();
    if (saving) return;
    const video = player.currentKey();
    const main = page.findMainVideo();
    if (!video || main.status === "none") return;
    if (main.status === "ad") return button.flash(text().adPlaying);
    if (!player.confirmed()) return button.flash(text().switching);
    // 连点几下不该存出几条一样的笔记：在途时忽略，不排队。
    saving = true;
    button.flash(text().saving, 0);
    try {
      const reply = await runtime.send("notes.saveAtTime", { video, atSec: noteTimestamp(main.video) });
      if (!runtime.alive()) return showReloadHint();
      if (reply.ok) {
        button.setTitle(text().noteTitle);
        button.flash(reply.value.duplicate ? text().duplicate : reply.value.polishLimited ? text().savedUnpolished : text().saved);
      } else {
        const short: Partial<Record<ErrorCode, string>> = text().shortFailures;
        button.setTitle(describe(reply.code, reply.detail, lang.current()));
        button.flash(short[reply.code] ?? text().saveFailed);
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
      title: () => text().cardTitle,
      // 卡片要插的地方周围是什么底色；没有右栏时悬浮在页面上，看页面本身。
      tone() {
        const view = document.defaultView;
        const start = page.cardSlot?.()?.parent ?? document.body;
        return view ? pageTone<Element>(start, (node) => view.getComputedStyle(node).backgroundColor) : null;
      },
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
      // 语言变了：图标的悬停提示跟着换，卡片框架的名字在下一轮自查时换。
      if (lang.update(view)) {
        button.setTitle(retired ? text().reloadTitle : text().noteTitle);
        (FEATURE_FRAME_EXPLAIN ? retitleFrameIcon : undefined)?.(icons, lang.current());
      }
      if (!retired) syncCard();
    },
    retire() {
      retired = true;
      card?.remove();
      card = null;
      button.setTitle(text().reloadTitle);
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
