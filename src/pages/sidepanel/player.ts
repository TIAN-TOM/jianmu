/// <reference types="chrome" />
// 侧边栏发给视频页内容脚本的播放器指令：跳转、读播放位置。每条都带视频身份，内容脚本核对正在放的视频。
// 送不到内容脚本（安装、更新之前就开着的页面）算没连上，提示用户刷新视频页。
import { signal, type ReadonlySignal } from "@preact/signals";
import type { VideoKey } from "../../core/video-ref.ts";
import type { ContentCommandName, ContentCommands, ContentReply } from "../../shared/messages/content.ts";

export type PlayerReply<K extends ContentCommandName> = ContentReply<K> | { readonly ok: false; readonly code: "UNREACHABLE" };

export type PlayerFailure = ContentCommands[ContentCommandName]["refusal"] | "UNREACHABLE";

const FAILURE_TEXT: Readonly<Record<PlayerFailure, string>> = {
  VIDEO_CHANGED: "页面上的视频已经换了，刷新侧边栏或回到原视频再试。",
  AD_PLAYING: "正在播广告，等广告放完再跳。",
  NO_VIDEO: "页面上没找到视频。",
  FRAME_NOT_READY: "画面还没加载好。",
  PROTECTED: "这个视频的画面受保护。",
  CANVAS_TAINTED: "读不到这个视频的画面。",
  NOT_FOREGROUND: "视频页不在前台。",
  UNREACHABLE: "视频页还没连上简幕，刷新视频页后才能跳转。",
};

export const playerFailureText = (code: PlayerFailure): string => FAILURE_TEXT[code];

export interface PlayerTabs {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/** 播放位置；正在播广告时没有位置，停在原处。 */
export interface PlayPosition {
  readonly video: VideoKey;
  readonly atSec: number;
  readonly status: "playing" | "paused";
}

export interface Player {
  send<K extends ContentCommandName>(tabId: number, type: K, req: ContentCommands[K]["req"]): Promise<PlayerReply<K>>;
  /** 视频页连没连上：null 是还不知道。 */
  readonly connected: ReadonlySignal<boolean | null>;
  readonly position: ReadonlySignal<PlayPosition | null>;
  /** 换视频或换标签页：清空连接状态和位置，马上问一次。 */
  watch(tabId: number | null, video: VideoKey | null): void;
  /** 读播放位置的轮询，只在需要跟着播放滚动时开。 */
  setPolling(on: boolean): void;
  stop(): void;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** 每秒问一次播放位置：字幕跟随只要到句子这一级。 */
export const POLL_MS = 1000;

export function createPlayer({ tabs = chrome.tabs as PlayerTabs }: { readonly tabs?: PlayerTabs } = {}): Player {
  const connected = signal<boolean | null>(null);
  const position = signal<PlayPosition | null>(null);
  let current: { readonly tabId: number; readonly video: VideoKey } | null = null;
  let generation = 0;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function send<K extends ContentCommandName>(tabId: number, type: K, req: ContentCommands[K]["req"]): Promise<PlayerReply<K>> {
    let raw: unknown;
    try {
      raw = await tabs.sendMessage(tabId, { type, req });
    } catch {
      raw = undefined;
    }
    const reply: PlayerReply<K> =
      isRecord(raw) && (raw.ok === true || (raw.ok === false && typeof raw.code === "string")) ? (raw as ContentReply<K>) : { ok: false, code: "UNREACHABLE" };
    if (current?.tabId === tabId) connected.value = reply.ok || reply.code !== "UNREACHABLE";
    return reply;
  }

  // 换了视频后的第一次总要问，看连没连上；之后页面不可见时不问。
  async function poll(first = false): Promise<void> {
    timer = null;
    const asked = generation;
    const at = current;
    if (!at) return;
    if (first || typeof document === "undefined" || document.visibilityState === "visible") {
      const reply = await send(at.tabId, "player.getState", { video: at.video });
      if (asked !== generation) return;
      if (reply.ok && reply.value.status !== "ad") position.value = { video: at.video, atSec: reply.value.atSec, status: reply.value.status };
    }
    if (polling && asked === generation) timer = setTimeout(() => void poll(), POLL_MS);
  }

  const restart = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    generation += 1;
    if (current) void poll(true);
  };

  return {
    send,
    connected,
    position,
    watch(tabId, video) {
      const next = tabId !== null && video !== null ? { tabId, video } : null;
      if (next?.tabId === current?.tabId && next?.video === current?.video) return;
      current = next;
      connected.value = null;
      position.value = null;
      restart();
    },
    setPolling(on) {
      if (polling === on) return;
      polling = on;
      if (on) restart();
    },
    stop() {
      polling = false;
      current = null;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
