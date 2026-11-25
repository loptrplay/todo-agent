import assert from "node:assert/strict";
import { test } from "node:test";
import { dueStatus, selectTasks, type Task } from "../shared/tasks.ts";
import { normalizeDue, readLocalDue } from "./task-dates.ts";

test("日期仅值保留本地日历语义，并处理夏令时重复或不存在的时间", () => {
  const zone = "Europe/Paris";
  assert.equal(normalizeDue("2026-07-04", zone), "2026-07-04");
  assert.equal(normalizeDue("2026-07-04T15:00", zone), "2026-07-04T13:00:00.000Z");
  assert.equal(normalizeDue("2026-10-25T02:30:00+02:00", zone), "2026-10-25T00:30:00.000Z");
  assert.throws(() => normalizeDue("2026-03-29T02:30", zone), /不存在/);
  assert.throws(() => normalizeDue("2026-10-25T02:30", zone), /两个可能/);
});

test("用户本地午夜和精确截止时间决定任务状态，未设截止日期的任务排最后", () => {
  const now = new Date("2026-08-12T23:00:00Z");
  const zone = "Europe/Paris";
  const task = (id: string, dueAt?: string): Task => ({ id, title: id, done: false, dueAt });
  const allDay = task("全天", "2026-08-13");
  const elapsed = task("已过时刻", "2026-08-12T22:30:00.000Z");
  const future = task("未来时刻", "2026-08-13T08:00:00.000Z");
  const noDate = task("未设日期");
  assert.deepEqual(dueStatus(allDay, now, zone), { today: true, overdue: false, future: false });
  assert.deepEqual(dueStatus(elapsed, now, zone), { today: true, overdue: true, future: false });
  assert.deepEqual(selectTasks([noDate, future, elapsed, allDay], { sort: "due" }, now, zone), [
    allDay,
    elapsed,
    future,
    noDate,
  ]);
});

test("本地语法以用户时区计算后天、周五和下周一，并保留纯日期", () => {
  const now = new Date("2026-11-26T23:30:00Z");
  assert.deepEqual(readLocalDue("后天交报告", now, "Europe/Paris"), {
    dueAt: "2026-11-29",
    rest: "交报告",
  });
  assert.deepEqual(readLocalDue("周五买牛奶", now, "Europe/Paris"), {
    dueAt: "2026-11-27",
    rest: "买牛奶",
  });
  const next = readLocalDue("下周一上午九点半开会", now, "Europe/Paris");
  assert.deepEqual(next, { dueAt: "2026-11-30T09:30", rest: "开会" });
  assert.equal(normalizeDue(next?.dueAt, "Europe/Paris"), "2026-11-30T08:30:00.000Z");
  const change = readLocalDue("明天凌晨两点半", new Date("2026-03-28T10:00Z"), "Europe/Paris");
  assert.throws(() => normalizeDue(change?.dueAt, "Europe/Paris"), /不存在/);
  assert.throws(() => readLocalDue("明天下午开会", now, "Europe/Paris"), /补充具体时刻/);
});
