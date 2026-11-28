// 按档位放宽的两个量钉成一张对照表：每次模型请求的硬超时、一个任务的保活预算。
// 任务运行器、笔记润色和按任务发请求的传输层各自读到的毫秒数都要和表里一样。
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createAiWiring } from "../../../src/background/ai.ts";
import { createNotesService } from "../../../src/background/services/notes.ts";
import { createNoteStore } from "../../../src/background/stores/notes.ts";
import { createTaskRunner } from "../../../src/background/tasks.ts";
import type { TransportError } from "../../../src/core/ai/transport/index.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { ok } from "../../../src/core/errors.ts";
import type { NoteRecord } from "../../../src/core/notes/records.ts";
import type { FrozenGen } from "../../../src/core/tasks.ts";
import type { KeepAlive } from "../../../src/platform/keepalive.ts";
import { createLocks } from "../../../src/platform/locks.ts";
import { createPermissions } from "../../../src/platform/permissions.ts";
import { createSettingsStore } from "../../../src/platform/settings-store.ts";
import { createFakeChrome } from "../../helpers/chrome.ts";
import { nextTurn } from "../../helpers/deferred.ts";
import { createFakeAi } from "../../helpers/fake-ai.ts";
import { hangUntilAborted, keyedStorage, modelService } from "../../helpers/fake-model-service.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { createMemoryDriver } from "../../helpers/memory-driver.ts";
import { cue, transcriptView, VIDEO } from "../../helpers/study-service.ts";
import { until } from "../../helpers/wait-until.ts";

type Efforts = Pick<FrozenGen, "effort" | "requestedEffort">;

/** 档位 → 硬超时、保活预算，单位毫秒。 */
const TABLE: readonly (readonly [Efforts, number, number])[] = [
  [{ effort: "off" }, 120_000, 660_000],
  [{ effort: "low" }, 120_000, 660_000],
  [{ effort: "medium" }, 180_000, 960_000],
  [{ effort: "high" }, 300_000, 1_560_000],
  [{ effort: "low", requestedEffort: "high" }, 300_000, 1_560_000],
  [{ effort: "off", requestedEffort: "medium" }, 180_000, 960_000],
  [{ effort: "low", requestedEffort: "off" }, 120_000, 660_000],
];

const GEN: FrozenGen = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "fake-model", effort: "off", promptVersion: "p1" };

/** 只记下每次登记的预算，不真的保活。 */
function recordingKeepAlive() {
  const held: number[] = [];
  const during: number[] = [];
  const keepAlive: KeepAlive = {
    hold(budgetMs) {
      held.push(budgetMs);
      return () => {};
    },
    async during(budgetMs, work) {
      during.push(budgetMs);
      return await work();
    },
  };
  return { keepAlive, held, during };
}

test("任务运行器：整个任务的保活和每次请求的保活都按表里的预算", async () => {
  for (const [efforts, , keepAliveMs] of TABLE) {
    const label = JSON.stringify(efforts);
    const recorder = recordingKeepAlive();
    const fake = createFakeAi({ replies: { "*": "回复" } });
    const tasks = createTaskRunner({ ai: fake.ai, keepAlive: recorder.keepAlive, timers: manualTimers(), broadcast: () => {}, newId: () => "task" });
    const registered = await tasks.register({ kind: "overview", origin: "user", video: VIDEO, gen: { ...GEN, ...efforts }, followsPage: false }, {});
    assert.ok("task" in registered, label);
    await tasks.run(registered.task.id, async ({ ai }) => {
      await ai.requestAiCompletion({ messages: [{ role: "user", content: "概览" }], maxTokens: 16 });
      return ok("完成");
    }, { autoFinish: true });
    assert.deepEqual(recorder.held, [keepAliveMs], label);
    assert.deepEqual(recorder.during, [keepAliveMs], label);
  }
});

test("笔记润色：排上润色时登记的保活按表里的预算", async () => {
  for (const [efforts, , keepAliveMs] of TABLE) {
    const label = JSON.stringify(efforts);
    const recorder = recordingKeepAlive();
    const fake = createFakeAi({ replies: { notes: "{}" } });
    const guard = createClearGuard();
    const notes = createNotesService({
      notes: createNoteStore({ driver: createMemoryDriver<NoteRecord>("notes", []), guard, canonicalUrl: () => "https://video.example/" }),
      transcript: {
        ensure: async () => ok({ view: transcriptView(VIDEO, [cue(0, "第一句话")]), generation: 0 }),
        get: async () => ok(transcriptView(VIDEO, [cue(0, "第一句话")])),
      },
      ai: { ...fake.ai, freeze: async (feature) => ({ ...GEN, feature, ...efforts }) },
      keepAlive: recorder.keepAlive,
      guard,
      broadcast: () => {},
      defer: () => {},
      log: { warn() {}, error() {} },
      now: () => 1000,
      newId: () => "note",
    });
    const saved = await notes.save({ video: VIDEO, atSec: 1 });
    assert.ok(saved.ok, label);
    assert.deepEqual(recorder.held, [keepAliveMs], label);
  }
});

test("按任务发请求：硬超时按表里的毫秒数", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [efforts, timeoutMs] of TABLE) {
    const label = JSON.stringify(efforts);
    const service = modelService(hangUntilAborted);
    const fake = createFakeChrome({ ...keyedStorage({ presetId: "deepseek", aiModel: "deepseek-v4-flash" }, "https://api.deepseek.com/"), grantedOrigins: ["https://api.deepseek.com/"], fetch: service.fetch });
    const storage = { local: fake.local, session: fake.session };
    const ai = createAiWiring({
      settings: createSettingsStore({ storage, locks: createLocks() }),
      storage,
      permissions: createPermissions(fake.chrome.permissions, () => ({})),
      fetch: service.fetch,
      clearGuard: createClearGuard(),
      prompts: {},
      uiLanguage: () => "zh",
    });
    const task = ai.forTask({ feature: "qa", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", promptVersion: "1", ...efforts });
    let settled: TransportError | "resolved" | undefined;
    void task.requestAiCompletion({ messages: [{ role: "user", content: "词" }], maxTokens: 512 }).then(
      () => (settled = "resolved"),
      (error: TransportError) => (settled = error),
    );
    assert.ok(await until(() => service.sent.length === 1), label);
    t.mock.timers.tick(timeoutMs - 1);
    await nextTurn();
    assert.equal(settled, undefined, `${label}：还没到 ${timeoutMs} 毫秒`);
    t.mock.timers.tick(1);
    assert.ok(await until(() => settled !== undefined), `${label}：到 ${timeoutMs} 毫秒就停`);
    assert.equal((settled as unknown as TransportError).code, "AI_HARD_TIMEOUT", label);
  }
});
