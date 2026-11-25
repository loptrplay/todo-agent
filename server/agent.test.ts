import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  Completions,
  type ChatCompletion,
  type ChatCompletionCreateParamsNonStreaming,
  type ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { reply, type ChatMessage } from "./agent.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

function setKey(t: TestContext, value?: string) {
  const original = process.env.DEEPSEEK_API_KEY;
  if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = value;
  t.after(() => {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  });
}

function mockModel(
  t: TestContext,
  respond: (request: ChatCompletionCreateParamsNonStreaming, index: number) => ChatCompletion,
) {
  setKey(t, "mock-api-key");
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  t.mock.method(
    Completions.prototype,
    "create",
    async (request: ChatCompletionCreateParamsNonStreaming) => {
      requests.push({ ...request, messages: [...request.messages] });
      return respond(request, requests.length - 1);
    },
  );
  return requests;
}

function completion(
  content: string | null,
  ...calls: ChatCompletionMessageFunctionToolCall[]
): ChatCompletion {
  return {
    id: "mock-completion",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: calls.length ? "tool_calls" : "stop",
        message: { role: "assistant", content, refusal: null, tool_calls: calls },
      },
    ],
  };
}

function call(
  id: string,
  name: string,
  args: object | string,
): ChatCompletionMessageFunctionToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function result(request: ChatCompletionCreateParamsNonStreaming, id: string) {
  const message = request.messages.find(
    (entry) => entry.role === "tool" && entry.tool_call_id === id,
  );
  assert.ok(message?.role === "tool" && typeof message.content === "string");
  return JSON.parse(message.content);
}

function store(t: TestContext, titles: string[] = []) {
  let nextId = 0;
  const items = titles.map((title) => ({ id: `task-${++nextId}`, title, done: false }));
  const tasks: TaskStore = {
    list: () => items.slice(),
    create(title) {
      const task = { id: `task-${++nextId}`, title, done: false };
      items.push(task);
      return task;
    },
    update(id, changes) {
      const task = items.find((item) => item.id === id);
      return task && Object.assign(task, changes);
    },
    remove(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    },
  };
  return {
    tasks,
    create: t.mock.method(tasks, "create"),
    update: t.mock.method(tasks, "update"),
    remove: t.mock.method(tasks, "remove"),
  };
}

function user(content: string): ChatMessage {
  return { role: "user", content };
}

async function temporaryStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  return { tasks: createJsonTaskStore(filename), filename };
}

test("自然语言新增任务，并在连续调用中查询和汇报实际完成状态", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const history: ChatMessage[] = [
    user("帮我记一下周五买牛奶"),
    { role: "assistant", content: "还有什么要记？" },
    user("把买牛奶这件事记下来，按前面说的周五，然后看看有哪些没做"),
  ];
  const requests = mockModel(t, (request, index) => {
    if (index === 0) {
      return completion(null, call("create", "create_task", { title: "周五买牛奶" }));
    }
    if (index === 1) return completion(null, call("list", "list_tasks", {}));
    return completion(`未完成：${result(request, "list").tasks[0].title}`);
  });
  assert.equal(await reply(history, tasks), "未完成：周五买牛奶");
  assert.deepEqual(requests[0].messages.slice(1), history);
  assert.deepEqual(
    requests[0].tools?.map((tool) => tool.type === "function" && tool.function.name),
    ["create_task", "list_tasks", "complete_task", "delete_task"],
  );
  const [saved] = tasks.list();
  assert.ok(saved?.id);
  const expected = { id: saved.id, title: "周五买牛奶", done: false };
  assert.deepEqual(result(requests[1], "create").task, expected);
  assert.deepEqual(result(requests[2], "list").tasks, [expected]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [expected]);
});

test("多轮对话完成任务后从未完成清单排除它，删除后从全部清单移除它", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const parcel = tasks.create("取快递");
  const update = t.mock.method(tasks, "update");
  const remove = t.mock.method(tasks, "remove");
  const dialogue = [user("我的任务有哪些？")];
  const list = completion(null, call("list", "list_tasks", {}));
  const requests = mockModel(t, (request, index) => {
    switch (index) {
      case 0:
      case 2:
      case 10:
        return list;
      case 1:
      case 11: {
        const items: { title: string }[] = result(request, "list").tasks;
        return completion(items.map(({ title }) => title).join("、"));
      }
      case 3: {
        const previous = request.messages[2];
        if (previous?.role !== "assistant" || typeof previous.content !== "string") {
          return completion("你指的是哪条任务？");
        }
        const title = previous.content.split("、")[0];
        const items: { id: string; title: string }[] = result(request, "list").tasks;
        return completion(
          null,
          call("complete", "complete_task", {
            task_id: items.find((task) => task.title === title)?.id,
          }),
        );
      }
      case 4:
        return completion(null, call("remaining", "list_tasks", {}));
      case 5: {
        const items: { title: string; done: boolean }[] = result(request, "remaining").tasks;
        return completion(
          `未完成：${items
            .filter(({ done }) => !done)
            .map(({ title }) => title)
            .join("、")}`,
        );
      }
      case 6:
        return completion(null, call("complete", "complete_task", { task_id: milk.id }));
      case 7:
        return completion(result(request, "complete").message);
      case 8:
        return completion(null, call("delete", "delete_task", { task_id: parcel.id }));
      case 9:
        return completion(result(request, "delete").message);
      default:
        throw new Error(`unexpected model request ${index}`);
    }
  });

  const initial = await reply(dialogue, tasks);
  assert.equal(initial, "买牛奶、取快递");
  dialogue.push({ role: "assistant", content: initial }, user("第一项做完了，还有哪些没做？"));
  assert.equal(await reply(dialogue, tasks), "未完成：取快递");
  assert.deepEqual(requests[2].messages.slice(1), dialogue);
  const completed = { ...milk, done: true };
  assert.deepEqual(result(requests[4], "complete").task, completed);
  assert.deepEqual(result(requests[5], "remaining").tasks, [completed, parcel]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [completed, parcel]);

  assert.match(await reply([user("再把买牛奶设为完成")], tasks), /已经完成/);
  assert.equal(result(requests[7], "complete").status, "already_done");
  assert.equal(update.mock.callCount(), 1);

  assert.match(await reply([user("帮我删掉取快递这个任务")], tasks), /已删除/);
  assert.deepEqual(result(requests[9], "delete").task, parcel);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(await reply([user("再看看全部任务")], tasks), "买牛奶");
  assert.deepEqual(result(requests[11], "list").tasks, [completed]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [completed]);
});

test("按展示顺序定位第二项，并使用同一 UUID 删除刚完成的任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const parcel = tasks.create("取快递");
  const book = tasks.create("还书");
  const list = completion(null, call("list", "list_tasks", {}));
  const requests = mockModel(t, (request, index) => {
    if ([0, 2, 5].includes(index)) return list;
    if (index === 1) {
      const [first, second, third] = result(request, "list").tasks;
      return completion(`1. ${second.title}\n2. ${first.title}\n3. ${third.title}`);
    }
    if (index === 3 || index === 6) {
      const previous = request.messages[index === 3 ? 2 : 4];
      assert.ok(previous?.role === "assistant" && typeof previous.content === "string");
      const visibleTitle = previous.content.match(index === 3 ? /^2\. (.+)$/m : /「(.+)」/)?.[1];
      const items: { id: string; title: string }[] = result(request, "list").tasks;
      const task_id = items.find((task) => task.title === visibleTitle)?.id;
      const name = index === 3 ? "complete_task" : "delete_task";
      return completion(null, call("change", name, { task_id }));
    }
    return completion(result(request, "change").message);
  });

  const history = [user("列出清单")];
  const listed = await reply(history, tasks);
  assert.equal(listed, "1. 取快递\n2. 买牛奶\n3. 还书");
  history.push({ role: "assistant", content: listed }, user("把第二项标记为完成"));
  const completed = await reply(history, tasks);
  assert.match(completed, /已标记完成「买牛奶」/);
  assert.deepEqual(result(requests[3], "list").tasks, [milk, parcel, book]);
  assert.deepEqual(result(requests[4], "change").task, { ...milk, done: true });
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...milk, done: true }, parcel, book]);

  history.push({ role: "assistant", content: completed }, user("删掉刚才那个任务"));
  assert.match(await reply(history, tasks), /已删除待办「买牛奶」/);
  assert.deepEqual(result(requests[7], "change").task, { ...milk, done: true });
  assert.deepEqual(createJsonTaskStore(filename).list(), [parcel, book]);
});

test("同名和相似任务需要澄清，用户明确选择 ID 后才能删除", async (t) => {
  const { tasks, remove, update } = store(t, ["买牛奶", "买牛奶", "周五买牛奶"]);
  const requests = mockModel(t, (request, index) => {
    if (index === 0)
      return completion(
        null,
        call("lookup", "list_tasks", { title_query: "买牛奶" }),
        call("delete", "delete_task", { task_id: "task-3" }),
      );
    if (index === 2)
      return completion(null, call("selected", "delete_task", { task_id: "task-2" }));
    if (index === 3) return completion(result(request, "selected").message);
    return completion("已删除。");
  });
  const answer = await reply([user("删掉买牛奶")], tasks);
  assert.match(answer, /请提供.*任务 ID/);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(result(requests[1], "lookup").tasks.length, 3);
  assert.equal(result(requests[1], "delete").status, "skipped");
  assert.equal(requests[1].tool_choice, "none");
  assert.match(await reply([user("请删除 task-2")], tasks), /已删除待办/);
  assert.deepEqual(
    tasks.list().map((task) => task.id),
    ["task-1", "task-3"],
  );
});

test("任务不存在或输入不完整时给出提示", async (t) => {
  const { tasks, update } = store(t);
  const requests = mockModel(t, (_request, index) => {
    if (index === 0)
      return completion(null, call("missing", "list_tasks", { title_query: "买牛奶" }));
    if (index === 1) return completion("已完成。");
    return completion("你想记下什么任务？");
  });
  assert.match(await reply([user("牛奶买好了")], tasks), /找不到待办/);
  assert.equal(result(requests[1], "missing").status, "not_found");
  assert.equal(await reply([user("帮我记一下")], tasks), "你想记下什么任务？");
  assert.equal(update.mock.callCount(), 0);
});

test("删除不存在的 UUID 时保留同名标题和其他任务的完成状态", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const missingId = randomUUID();
  const sameTitle = tasks.create(missingId);
  const milk = tasks.create("买牛奶");
  const parcel = tasks.create("取快递");
  tasks.update(parcel.id, { done: true });
  const remove = t.mock.method(tasks, "remove");
  const requests = mockModel(t, (_request, index) =>
    index === 0
      ? completion(null, call("missing", "delete_task", { task_id: missingId }))
      : completion("已删除。"),
  );

  assert.ok(
    (await reply([user("把这条不存在的任务删掉")], tasks)).includes(
      `找不到待办（ID：${missingId}）`,
    ),
  );
  assert.equal(result(requests[1], "missing").status, "not_found");
  assert.equal(remove.mock.callCount(), 0);
  assert.deepEqual(createJsonTaskStore(filename).list(), [
    sameTitle,
    milk,
    { ...parcel, done: true },
  ]);
});

test("完成请求匹配多个不同标题时先澄清，所有任务保持原状", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const friday = tasks.create("周五买牛奶");
  const sunday = tasks.create("周日买牛奶");
  const update = t.mock.method(tasks, "update");
  const requests = mockModel(t, (_request, index) =>
    index === 0
      ? completion(null, call("lookup", "list_tasks", { title_query: "牛奶" }))
      : completion("已完成。"),
  );

  const answer = await reply([user("牛奶已经买好了")], tasks);
  assert.match(answer, /周五买牛奶.*周日买牛奶.*请提供/);
  const candidates = result(requests[1], "lookup");
  assert.equal(candidates.status, "ambiguous");
  assert.deepEqual(candidates.tasks, [friday, sunday]);
  assert.equal(update.mock.callCount(), 0);
  assert.deepEqual(createJsonTaskStore(filename).list(), [friday, sunday]);
});

test("拒绝模型生成的非法 JSON、错误字段和空标题", async (t) => {
  const { tasks, create } = store(t);
  const invalidArgs = ["{", { title: "买牛奶", done: true }, { title: " " }];
  const requests = mockModel(t, (_request, index) =>
    index % 2 === 0
      ? completion(null, call("invalid", "create_task", invalidArgs[index / 2]))
      : completion("已成功新增。"),
  );
  for (const _args of invalidArgs) {
    assert.match(await reply([user("帮我记一个任务")], tasks), /参数无效/);
  }
  assert.equal(result(requests[1], "invalid").status, "invalid");
  assert.equal(create.mock.callCount(), 0);
});

test("模型异常时拒绝报告未经执行的操作，并保留已执行操作的回执", async (t) => {
  const { tasks, create } = store(t);
  mockModel(t, (_request, index) => {
    if (index === 1) return completion(null, call("create", "create_task", { title: "买牛奶" }));
    throw new Error("connection failed");
  });
  assert.match(await reply([user("记下买牛奶")], tasks), /^暂时无法完成 DeepSeek 请求/);
  assert.equal(create.mock.callCount(), 0);
  assert.match(
    await reply([user("记下买牛奶")], tasks),
    /已添加待办「买牛奶」。\n暂时无法完成 DeepSeek 请求/,
  );
  assert.equal(create.mock.callCount(), 1);
});

test("连续工具调用达到上限时终止且不执行额外操作", async (t) => {
  const { tasks, create } = store(t);
  const requests = mockModel(t, (_request, index) =>
    completion(null, call(`call-${index}`, "create_task", { title: `任务 ${index}` })),
  );
  assert.match(await reply([user("新增一些任务")], tasks), /工具调用上限/);
  assert.equal(requests.length, 6);
  assert.equal(requests.at(-1)?.tool_choice, "none");
  assert.equal(create.mock.callCount(), 5);
});

test("无 API Key 时沿用规则处理四种任务操作", async (t) => {
  setKey(t);
  const { tasks } = store(t);
  const client = t.mock.method(Completions.prototype, "create", () => {
    throw new Error("unexpected model call");
  });
  assert.match(await reply([user("帮我记一下买牛奶")], tasks), /已添加/);
  assert.match(await reply([user("我有哪些任务？")], tasks), /买牛奶（未完成）/);
  assert.match(await reply([user("牛奶买好了")], tasks), /已标记完成/);
  assert.match(await reply([user("买牛奶这条删掉吧")], tasks), /已删除/);
  assert.deepEqual(tasks.list(), []);
  assert.equal(client.mock.callCount(), 0);
});
