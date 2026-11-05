import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskManager, type Task } from "../../../src/core/tasks.ts";
import { videoKey } from "../../../src/core/video-ref.ts";

const PART_1 = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 1 });
const PART_2 = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 2 });

test("同一目标同类任务只能运行一个", () => {
  const manager = createTaskManager({ now: () => 1000 });
  const first = manager.start({ id: "task-1", kind: "analysis", key: `analysis:${PART_1}` });
  const repeated = manager.start({ id: "task-2", kind: "analysis", key: `analysis:${PART_1}` });

  assert.equal(first.success, true);
  assert.equal(repeated.success, false);
  assert.equal(repeated.error, "TASK_ALREADY_RUNNING");
  assert.equal(repeated.task.id, "task-1");
  assert.equal(manager.list().length, 1);
});

test("取消任务会中止信号并广播取消状态", () => {
  const changes: Task[] = [];
  const manager = createTaskManager({
    now: () => 1000,
    onChange: (task) => changes.push(task),
  });
  manager.start({ id: "task-1", kind: "qa", key: `qa:${PART_1}` });

  const result = manager.cancel("task-1");

  assert.equal(result.success, true);
  assert.equal(manager.signal("task-1")?.aborted, true);
  assert.equal(changes.at(-1)?.state, "canceled");
  assert.equal(changes.at(-1)?.message, "已取消");
});

test("已取消、操作还在跑的任务不再更新进度", () => {
  const manager = createTaskManager();
  manager.start({ id: "task-1", kind: "analysis", key: `analysis:${PART_1}` });
  manager.claim("task-1");
  manager.cancel("task-1");
  assert.equal(manager.progress("task-1", { done: 1 }), null);
});

test("进度只更新运行中的任务，结束后从活动列表移除", () => {
  const changes: Task[] = [];
  const manager = createTaskManager({ onChange: (task) => changes.push(task) });
  manager.start({ id: "task-1", kind: "analysis", key: `analysis:${PART_1}` });
  manager.progress("task-1", { done: 2, total: 5, phase: "generating", message: "正在生成" });

  const current = manager.get("task-1");
  assert.ok(current);
  assert.deepEqual(current, {
    id: "task-1",
    kind: "analysis",
    key: `analysis:${PART_1}`,
    state: "running",
    done: 2,
    total: 5,
    phase: "generating",
    message: "正在生成",
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
  assert.equal(typeof current.createdAt, "number");
  assert.equal(typeof current.updatedAt, "number");

  const finished = manager.finish("task-1", { state: "completed", message: "已完成" });
  assert.equal(finished?.state, "completed");
  assert.equal(changes.at(-1)?.state, "completed");
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.progress("task-1", { done: 3 }), null, "结束后的任务不再更新进度");
});

const HOLDING = { holdKeyAfterCancel: ["triage-verdict"] };
const VERDICT_KEY = `triage-verdict:${PART_1}`;

test("粗筛结论取消时操作还在跑：收尾之前仍占着这个键，收尾之后才让出来", () => {
  const manager = createTaskManager(HOLDING);
  manager.start({ id: "old", kind: "triage-verdict", key: VERDICT_KEY });
  const signal = manager.claim("old");
  assert.equal(signal, manager.signal("old"), "claim 交回的就是这个任务的信号");
  manager.cancel("old");
  assert.equal(signal?.aborted, true);

  const reopened = manager.start({ id: "new", kind: "triage-verdict", key: VERDICT_KEY });
  assert.equal(reopened.success, false);
  assert.equal(reopened.error, "TASK_ALREADY_RUNNING");
  assert.equal(reopened.task.id, "old");
  assert.equal(reopened.task.state, "canceled");
  assert.equal("operating" in reopened.task, false, "内部标记不出现在快照里");

  const finished = manager.finish("old", { state: "completed" });
  assert.equal(finished?.state, "canceled", "收尾不覆盖已取消的状态");
  const later = manager.start({ id: "new", kind: "triage-verdict", key: VERDICT_KEY });
  assert.equal(later.success, true);
});

test("粗筛结论还没开始操作就取消：不占键，页面关掉后那次操作不会来也不会一直卡着", () => {
  const manager = createTaskManager(HOLDING);
  manager.start({ id: "old", kind: "triage-verdict", key: VERDICT_KEY });
  manager.cancel("old");
  const reopened = manager.start({ id: "new", kind: "triage-verdict", key: VERDICT_KEY });
  assert.equal(reopened.success, true);
});

test("其他种类取消后键马上让出来：侧边栏停掉概览后可以立刻重新生成", () => {
  const manager = createTaskManager(HOLDING);
  for (const kind of ["analysis", "translate", "qa"]) {
    const key = `${kind}:${PART_1}`;
    manager.start({ id: `${kind}-1`, kind, key });
    manager.claim(`${kind}-1`);
    manager.cancel(`${kind}-1`);
    const again = manager.start({ id: `${kind}-2`, kind, key });
    assert.equal(again.success, true, kind);
  }
});

test("没有指定 holdKeyAfterCancel 时，粗筛结论取消后也马上让出键", () => {
  const manager = createTaskManager();
  manager.start({ id: "old", kind: "triage-verdict", key: VERDICT_KEY });
  manager.claim("old");
  manager.cancel("old");
  assert.equal(manager.start({ id: "new", kind: "triage-verdict", key: VERDICT_KEY }).success, true);
});

// 登记了却一直没人认领（发起页面在登记和发生成请求之间关掉了）：后台到点用 expireIfUnclaimed 收掉。
test("登记后一直没认领：expireIfUnclaimed 按取消收尾、广播，键让出来", () => {
  const changes: Task[] = [];
  const manager = createTaskManager({ onChange: (task) => changes.push(task) });
  manager.start({ id: "a", kind: "analysis", key: `analysis:${PART_1}` });

  const expired = manager.expireIfUnclaimed("a", { message: "没有收到生成请求，已停止" });

  assert.equal(expired?.state, "canceled");
  assert.equal(changes.at(-1)?.state, "canceled");
  assert.equal(changes.at(-1)?.message, "没有收到生成请求，已停止");
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.start({ id: "b", kind: "analysis", key: `analysis:${PART_1}` }).success, true);
});

test("已经认领的任务 expireIfUnclaimed 不动它", () => {
  const manager = createTaskManager();
  manager.start({ id: "a", kind: "analysis", key: `analysis:${PART_1}` });
  manager.claim("a");

  assert.equal(manager.expireIfUnclaimed("a"), null);
  assert.equal(manager.get("a")?.state, "running");
  assert.equal(manager.expireIfUnclaimed("missing"), null);
});

test("还没认领就取消：条目直接删掉，不在列表里一直留着", () => {
  const manager = createTaskManager(HOLDING);
  for (const kind of ["analysis", "triage-verdict"]) {
    manager.start({ id: `${kind}-1`, kind, key: `${kind}:${PART_1}` });
    const result = manager.cancel(`${kind}-1`);
    assert.equal(result.success, true, kind);
    assert.equal(result.task.state, "canceled", kind);
  }
  assert.deepEqual(manager.list(), []);
});

test("取消或过期后才迟到的认领拿到已中止的信号，按已取消收尾，不报「任务已经结束」", () => {
  const manager = createTaskManager();
  manager.start({ id: "a", kind: "analysis", key: `analysis:${PART_1}` });
  manager.cancel("a");
  assert.equal(manager.claim("a")?.aborted, true);

  manager.start({ id: "b", kind: "analysis", key: `analysis:${PART_2}` });
  manager.expireIfUnclaimed("b");
  assert.equal(manager.claim("b")?.aborted, true);

  assert.equal(manager.claim("never-registered"), null);
  assert.deepEqual(manager.list(), []);
});

test("认领后取消、要占键的种类仍占到收尾", () => {
  const manager = createTaskManager(HOLDING);
  manager.start({ id: "old", kind: "triage-verdict", key: VERDICT_KEY });
  manager.claim("old");
  manager.cancel("old");
  assert.equal(manager.list().length, 1);
  assert.equal(manager.start({ id: "new", kind: "triage-verdict", key: VERDICT_KEY }).success, false);
});

test("操作还在跑时取消：广播标着 finishing，收尾（已完成的部分存好）时再广播一次不带它", () => {
  const changes: Task[] = [];
  const manager = createTaskManager({ now: () => 1000, onChange: (task) => changes.push(task) });
  manager.start({ id: "task-1", kind: "analysis", key: `analysis:${PART_1}` });
  manager.claim("task-1");

  manager.cancel("task-1");
  assert.equal(changes.at(-1)?.state, "canceled");
  assert.equal(changes.at(-1)?.finishing, true, "跟着这个任务的页面要等收尾再重读");

  manager.finish("task-1", { state: "canceled" });
  assert.equal(changes.at(-1)?.state, "canceled");
  assert.equal(changes.at(-1)?.finishing, undefined);
});

test("还没开始操作就取消：不标 finishing，跟着的页面马上收尾", () => {
  const changes: Task[] = [];
  const manager = createTaskManager({ now: () => 1000, onChange: (task) => changes.push(task) });
  manager.start({ id: "task-1", kind: "analysis", key: `analysis:${PART_1}` });
  manager.cancel("task-1");
  assert.equal(changes.at(-1)?.finishing, false);
});

test("取消时可以带上原因：认领到的信号上读得到，供收尾时区分「清除本机数据」和普通停止", () => {
  const manager = createTaskManager();
  manager.start({ id: "a", kind: "analysis", key: `analysis:${PART_1}` });
  const signal = manager.claim("a");
  const reason = Object.assign(new Error("本机数据已清除"), { code: "LOCAL_DATA_CLEARED" });
  manager.cancel("a", { reason });
  assert.equal(signal?.aborted, true);
  assert.equal(signal?.reason.code, "LOCAL_DATA_CLEARED");

  manager.start({ id: "b", kind: "analysis", key: `analysis:${PART_2}` });
  const plain = manager.claim("b");
  manager.cancel("b");
  assert.equal(plain?.aborted, true);
  assert.notEqual(plain?.reason?.code, "LOCAL_DATA_CLEARED", "普通停止不带这个原因");
});

test("onChange 抛错被吞掉，不影响任务", () => {
  const manager = createTaskManager({
    onChange: () => {
      throw new Error("监听失败");
    },
  });

  assert.equal(manager.start({ id: "a", kind: "analysis", key: `analysis:${PART_1}` }).success, true);
  assert.equal(manager.progress("a", { done: 1 })?.done, 1);
  assert.equal(manager.finish("a")?.state, "completed");

  manager.start({ id: "b", kind: "analysis", key: `analysis:${PART_2}` });
  assert.equal(manager.cancel("b").success, true);
  assert.deepEqual(manager.list(), []);
});

test("留下的已中止信号最多 50 条，超出时丢掉最早的", () => {
  const manager = createTaskManager();
  for (let index = 0; index <= 50; index += 1) {
    manager.start({ id: `task-${index}`, kind: "analysis", key: `analysis:${PART_1}` });
    manager.cancel(`task-${index}`);
  }

  assert.equal(manager.claim("task-0"), null, "第 51 条挤掉最早的一条");
  assert.equal(manager.claim("task-1")?.aborted, true);
  assert.equal(manager.claim("task-50")?.aborted, true);
});
