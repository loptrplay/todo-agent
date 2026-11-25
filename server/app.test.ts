import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage, ChatResponse } from "../shared/chat.ts";
import { parentTaskId, subtaskRelation } from "../shared/tasks.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext, respond?: (messages: ChatMessage[]) => ChatResponse) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return respond?.(messages) ?? "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("旧版自定义 parentId 原样保留，且不影响删除引用的任务", async (t) => {
  const { request, filename } = await startTestApp(t);
  const base = "/api/tasks";
  const original = { id: "old-parent", title: "旧任务", done: false };
  const legacy = {
    id: "legacy",
    title: "自定义字段",
    done: false,
    parentId: original.id,
    custom: { color: "green" },
  };
  await writeFile(filename, JSON.stringify([original, legacy]));

  const store = createJsonTaskStore(filename);
  assert.deepEqual(store.list(), [original, legacy]);
  assert.equal(parentTaskId(store.list()[1]), undefined);
  assert.equal((await request("DELETE", `${base}/${original.id}`)).status, 204);
  assert.deepEqual(createJsonTaskStore(filename).list(), [legacy]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("聊天 API 保留已展示任务的 ID 上下文供下一轮使用", async (t) => {
  const taskContext = { listed: ["task-parcel", "task-milk"] };
  const answer = { reply: "1. 取快递\n2. 买牛奶", taskContext };
  const { request, conversations } = await startTestApp(t, () => answer);
  const first: ChatMessage = { role: "user", content: "列出清单" };
  assert.deepEqual(await request("POST", "/api/chat", { messages: [first] }), {
    status: 200,
    body: answer,
  });
  const messages: ChatMessage[] = [
    first,
    { role: "assistant", content: answer.reply, taskContext },
    { role: "user", content: "删除第一项任务" },
  ];
  assert.equal((await request("POST", "/api/chat", { messages })).status, 200);
  assert.deepEqual(conversations.at(-1), messages);
});

test("任务 API 支持子任务、属性修改、关键词和优先级筛选及截止日期排序", async (t) => {
  const { request, filename } = await startTestApp(t);
  const base = "/api/tasks";
  const add = async (input: object) => {
    const response = await request("POST", base, input);
    assert.equal(response.status, 201);
    return response.body;
  };
  const parent = await add({ title: "报告计划" });
  const draft = await add({
    title: "报告初稿",
    parentId: parent.id,
    dueAt: "2026-12-04",
    priority: "高",
    effort: "大",
  });
  const prep = await add({
    title: "报告资料",
    parentId: parent.id,
    dueAt: "2026-12-02T15:00:00+01:00",
    priority: "高",
  });
  await add({ title: "报告校对", parentId: parent.id, priority: "低" });
  await add({ title: "旅行准备", priority: "高" });
  assert.equal(prep.dueAt, "2026-12-02T14:00:00.000Z");
  const filter = new URLSearchParams({
    search: "报告",
    priority: "高",
    sort: "due",
    timeZone: "Europe/Paris",
  });
  assert.deepEqual(await request("GET", `${base}?${filter}`), { status: 200, body: [prep, draft] });

  assert.equal((await request("DELETE", `${base}/${parent.id}`)).status, 409);
  assert.equal((await request("POST", base, { title: "第三级", parentId: draft.id })).status, 409);
  assert.equal(
    (await request("POST", base, { title: "无效日期", dueAt: "2026-02-30" })).status,
    400,
  );
  assert.equal((await request("GET", `${base}?timeZone=Invalid%2FZone`)).status, 400);
  const changed = await request("PATCH", `${base}/${draft.id}`, {
    dueAt: null,
    priority: "中",
    effort: "小",
    done: true,
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, {
    ...draft,
    done: true,
    dueAt: null,
    priority: "中",
    effort: "小",
  });
  const saved = createJsonTaskStore(filename).list();
  assert.deepEqual(
    saved.find((item) => item.id === draft.id),
    changed.body,
  );
  const children = saved.filter((item) => parentTaskId(item) === parent.id);
  assert.equal(children.length, 3);
  assert.ok(children.every((item) => item.taskRelation === subtaskRelation));
});
