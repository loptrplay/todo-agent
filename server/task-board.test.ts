import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { boardSections, taskGroup } from "../src/task-board-model.ts";
import { createJsonTaskStore } from "./task-store.ts";

const now = new Date("2026-11-25T12:00:00Z");
const zone = "Europe/Paris";

async function tempStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-board-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  return {
    tasks: createJsonTaskStore(filename),
    reopen: () => createJsonTaskStore(filename).list(),
  };
}

test("主任务已完成，仍按未完成子任务的状态分组，即使子任务被筛选隐藏", async (t) => {
  const { tasks, reopen } = await tempStore(t);
  const parent = tasks.create("旅行安排", { priority: "高" });
  const child = tasks.create("买机票", { parentId: parent.id, priority: "低" });
  tasks.update(parent.id, { done: true });

  const list = boardSections(reopen(), { priority: "高" }, now, zone);
  assert.equal(list.find(({ group }) => group === "已完成")?.cards.length, 0);
  const [pending] = list.find(({ group }) => group === "待处理")?.cards ?? [];
  assert.equal(pending.task.id, parent.id);
  assert.deepEqual(pending.children, []);
  assert.deepEqual(pending.childStats, { total: 1, done: 0, pending: 1, percent: 0 });

  tasks.update(child.id, { done: true });
  const done = boardSections(reopen(), {}, now, zone).find(
    ({ group }) => group === "已完成",
  )?.cards;
  assert.equal(done?.[0].task.id, parent.id);
  assert.equal(done?.[0].childStats.percent, 100);
});

test("已完成主任务下的逾期子任务仍未完成，且任务树进入逾期分组", async (t) => {
  const { tasks, reopen } = await tempStore(t);
  const parent = tasks.create("办理材料");
  const child = tasks.create("提交表格", { parentId: parent.id, dueAt: "2026-11-24" });
  tasks.update(parent.id, { done: true });

  const list = boardSections(reopen(), {}, now, zone);
  const [card] = list.find(({ group }) => group === "已逾期")?.cards ?? [];
  assert.equal(card.task.id, parent.id);
  assert.deepEqual(card.children, [child]);
  assert.equal(card.children[0].done, false);
  assert.equal(taskGroup(card.children[0], now, zone), "已逾期");
});

test("主任务只按自身截止日期排序，子任务独立排序", async (t) => {
  const { tasks, reopen } = await tempStore(t);
  const late = tasks.create("较晚截止", { dueAt: "2026-12-10" });
  const laterChild = tasks.create("较晚子项", { parentId: late.id, dueAt: "2026-12-06" });
  const earlierChild = tasks.create("较早子项", { parentId: late.id, dueAt: "2026-11-27" });
  const early = tasks.create("较早截止", { dueAt: "2026-12-01" });

  const cards = boardSections(reopen(), { sort: "due" }, now, zone).find(
    ({ group }) => group === "待处理",
  )?.cards;
  assert.deepEqual(
    cards?.map(({ task }) => task.id),
    [early.id, late.id],
  );
  assert.deepEqual(cards?.[1].children, [earlierChild, laterChild]);
});

test("关键词、优先级和工作量可一起筛选，匹配子任务保留父级", async (t) => {
  const { tasks, reopen } = await tempStore(t);
  const parent = tasks.create("出行准备");
  const matching = tasks.create("订火车票", { parentId: parent.id, priority: "高", effort: "小" });
  tasks.create("订飞机票", { parentId: parent.id, priority: "高", effort: "大" });
  tasks.create("订汽车票", { priority: "中", effort: "小" });
  const cards = boardSections(
    reopen(),
    { search: "订", priority: "高", effort: "小" },
    now,
    zone,
  ).flatMap(({ cards }) => cards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].task.id, parent.id);
  assert.deepEqual(cards[0].children, [matching]);
  assert.equal(cards[0].childStats.total, 2);
});
