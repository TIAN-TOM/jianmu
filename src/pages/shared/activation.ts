// 首次启用状态：问一次后台，确认启用，之后跟着启用广播和清除全部数据变。侧边栏、设置页和粗筛页共用。
// 还没问到、正在重问、问失败都算没启用：页面只在 enabled 为真时才去读视频、发起工作。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import type { ActivationKind, CarriedItems, NoticeItem, NoticeStatus } from "../../core/consent.ts";
import type { Failure } from "../../core/errors.ts";
import type { PageApi } from "./api.ts";

export type ActivationView =
  | { readonly state: "loading" }
  /** carried 只在开发者本人的日用包里有：照旧沿用，说明多出来、还没看过的条目。 */
  | { readonly state: "current"; readonly carried?: CarriedItems }
  | { readonly state: "needed"; readonly updated: boolean; readonly items: readonly NoticeItem<ActivationKind>[] }
  | { readonly state: "failed"; readonly failure: Failure };

/** 确认按钮的状态，和首次启用说明组件的写法一致。 */
export type ConfirmPhase = "idle" | "saving" | "failed";

export interface Activation {
  readonly view: ReadonlySignal<ActivationView>;
  readonly enabled: ReadonlySignal<boolean>;
  readonly phase: ReadonlySignal<ConfirmPhase>;
  /** 确认没写进去的原因，phase 是 failed 时有。 */
  readonly confirmFailure: ReadonlySignal<Failure | null>;
  /** 确认以后补注入没补上的标签页，侧边栏在这些页面上提示刷新。 */
  readonly unreachableTabs: ReadonlySignal<readonly number[]>;
  /** 问一次后台。新问的结果回来之前又有广播的，以广播为准。 */
  load(): Promise<void>;
  /** 写入中再点不重复发；写入失败留在这一页，原因放在 confirmFailure。 */
  confirm(): Promise<void>;
  /** 启用本来就算数，只是记下看过说明多出来的条目（开发者本人的日用包）：不动确认按钮的状态和补注入的结果。 */
  acknowledge(): Promise<void>;
  stop(): void;
}

export interface ActivationDeps {
  readonly api: Pick<PageApi, "send" | "on">;
}

const LOADING: ActivationView = { state: "loading" };
const CURRENT: ActivationView = { state: "current" };

function viewOf(status: NoticeStatus<ActivationKind>): ActivationView {
  if (status.state === "needed") return { state: "needed", updated: status.updated, items: status.items };
  return status.carried ? { state: "current", carried: status.carried } : CURRENT;
}

export function createActivation({ api }: ActivationDeps): Activation {
  const view = signal<ActivationView>(LOADING);
  const phase = signal<ConfirmPhase>("idle");
  const confirmFailure = signal<Failure | null>(null);
  const unreachableTabs = signal<readonly number[]>([]);
  let generation = 0;
  let losses = 0;
  let stopped = false;

  async function load(): Promise<void> {
    generation += 1;
    const asked = generation;
    const reply = await api.send("activation.get", {});
    if (stopped || asked !== generation) return;
    view.value = reply.ok ? viewOf(reply.value) : { state: "failed", failure: reply };
  }

  // 失效的先按没启用处理，再问后台要这次该给用户看的说明。
  const lost = (): void => {
    if (stopped) return;
    losses += 1;
    view.value = LOADING;
    void load();
  };

  const unsubscribe = [
    api.on("activation.changed", ({ confirmed }) => {
      if (!confirmed) return lost();
      generation += 1;
      view.value = CURRENT;
    }),
    api.on("data.cleared", ({ scope }) => {
      if (scope === "all") lost();
    }),
  ];

  return {
    view,
    enabled: computed(() => view.value.state === "current"),
    phase,
    confirmFailure,
    unreachableTabs,
    load,
    async confirm() {
      if (stopped || phase.peek() === "saving") return;
      phase.value = "saving";
      confirmFailure.value = null;
      const lossesBefore = losses;
      const reply = await api.send("activation.confirm", {});
      if (stopped) return;
      if (!reply.ok) {
        confirmFailure.value = reply;
        phase.value = "failed";
        return;
      }
      phase.value = "idle";
      // 等回答的工夫启用失效过：这份回答可能已经过时，不拿它算启用，重新问一次后台。
      if (losses !== lossesBefore) {
        await load();
        if (!stopped && view.peek().state === "current") unreachableTabs.value = reply.value.unreachableTabs;
        return;
      }
      generation += 1;
      view.value = viewOf(reply.value);
      unreachableTabs.value = reply.value.unreachableTabs;
    },
    async acknowledge() {
      if (stopped) return;
      const asked = generation;
      const reply = await api.send("activation.confirm", {});
      // 写不进去就留着那一行，下次再点；等回答的工夫状态又变过，以新的为准。
      if (stopped || !reply.ok || asked !== generation) return;
      generation += 1;
      view.value = viewOf(reply.value);
    },
    stop() {
      stopped = true;
      for (const off of unsubscribe) off();
    },
  };
}
