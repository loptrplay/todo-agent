import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import OpenAI from "openai";
import {
  Completions,
  type ChatCompletion,
  type ChatCompletionCreateParamsNonStreaming,
  type ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { reply as agentReply, replyTurn, type ChatMessage } from "./agent.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

const reply: typeof agentReply = (messages, tasks, options) =>
  agentReply(messages, tasks, { ...options, mode: "model" });

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

function chat(tasks: TaskStore, options: Parameters<typeof replyTurn>[2] = { mode: "model" }) {
  const messages: ChatMessage[] = [];
  return async (text: string) => {
    messages.push(user(text));
    const answer = await replyTurn(messages, tasks, options);
    messages.push({ role: "assistant", content: answer.reply, taskContext: answer.taskContext });
    return answer;
  };
}

for (const mode of ["无密钥规则", "模拟 DeepSeek"] as const) {
  test(`原题六步连续验收及重开存储（${mode}）`, async (t) => {
    const { tasks, filename } = await temporaryStore(t);
    const messages: ChatMessage[] = [];
    const send = async (text: string) => {
      messages.push(user(text));
      const answer = await reply(messages, tasks);
      messages.push({ role: "assistant", content: answer });
      return answer;
    };
    if (mode === "无密钥规则") {
      setKey(t);
    } else {
      mockModel(t, (request) => {
        const tail = request.messages.at(-1);
        if (tail?.role === "tool") {
          const output = result(request, tail.tool_call_id);
          if (output.tasks) {
            return completion(
              output.tasks
                .map(
                  (item: ReturnType<TaskStore["create"]>) =>
                    `${item.title}（${item.done ? "已完成" : "未完成"}）`,
                )
                .join("\n"),
            );
          }
          return completion(output.message);
        }
        switch (messages.length) {
          case 1:
            return completion(null, call("milk", "create_task", { title: "买牛奶" }));
          case 3:
            return completion(null, call("parcel", "create_task", { title: "取快递" }));
          case 5:
          case 11:
            return completion(null, call("list", "list_tasks", {}));
          case 7:
            return completion(
              null,
              call("finish", "complete_task", { task_id: tasks.list()[0].id }),
            );
          case 9:
            return completion(null, call("delete", "delete_task", { task_id: tasks.list()[1].id }));
          default:
            throw new Error("意外的验收步骤");
        }
      });
    }

    await send("帮我记一下买牛奶");
    const [milk] = tasks.list();
    assert.ok(milk.id);
    assert.deepEqual(tasks.list(), [{ id: milk.id, title: "买牛奶", done: false }]);
    await send("再记一条取快递");
    const [, parcel] = tasks.list();
    assert.notEqual(parcel.id, milk.id);
    assert.deepEqual(tasks.list(), [milk, { id: parcel.id, title: "取快递", done: false }]);
    const initial = await send("我有哪些任务？");
    assert.match(initial, /买牛奶（未完成）[\s\S]*取快递（未完成）/);
    assert.deepEqual(tasks.list(), [milk, parcel]);
    await send("牛奶买好了");
    const completed = { ...milk, done: true };
    assert.deepEqual(tasks.list(), [completed, parcel]);
    await send("取快递这条删掉吧");
    assert.deepEqual(tasks.list(), [completed]);
    const finalList = await send("再给我看看清单");
    assert.match(finalList, /买牛奶（已完成）/);
    assert.doesNotMatch(finalList, /取快递/);
    assert.deepEqual(tasks.list(), [completed]);
    assert.deepEqual(createJsonTaskStore(filename).list(), [completed]);
  });
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
  assert.match(await reply(history, tasks), /已添加待办「周五买牛奶」[\s\S]*周五买牛奶（未完成）/);
  assert.deepEqual(requests[0].messages.slice(1), history);
  assert.deepEqual(
    requests[0].tools?.map((tool) => tool.type === "function" && tool.function.name),
    ["create_task", "list_tasks", "complete_task", "delete_task", "update_task", "clarify_task"],
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
        const title = previous.content.match(/^1\. (.+?)（(?:未完成|已完成)）/m)?.[1];
        const items: { id: string; title: string }[] = result(request, "list").tasks;
        return completion(
          null,
          call("complete", "complete_task", {
            task_id: items.find((task) => task.title === title)?.id,
          }),
        );
      }
      case 4:
        return completion(null, call("remaining", "list_tasks", { done: false }));
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
  assert.match(initial, /^1\. 买牛奶（未完成）\n2\. 取快递（未完成）/);
  dialogue.push({ role: "assistant", content: initial }, user("第一项做完了，还有哪些没做？"));
  const remaining = await reply(dialogue, tasks);
  assert.match(remaining, /已标记完成「买牛奶」[\s\S]*1\. 取快递（未完成）/);
  assert.doesNotMatch(remaining, /^\d+\. 买牛奶/m);
  assert.deepEqual(requests[2].messages.slice(1), dialogue);
  const completed = { ...milk, done: true };
  assert.deepEqual(result(requests[4], "complete").task, completed);
  assert.deepEqual(result(requests[5], "remaining").tasks, [parcel]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [completed, parcel]);

  assert.match(await reply([user("再把买牛奶设为完成")], tasks), /已经完成/);
  assert.equal(result(requests[7], "complete").status, "already_done");
  assert.equal(update.mock.callCount(), 1);

  assert.match(await reply([user("帮我删掉取快递这个任务")], tasks), /已删除/);
  assert.deepEqual(result(requests[9], "delete").task, parcel);
  assert.equal(remove.mock.callCount(), 1);
  assert.match(await reply([user("再看看全部任务")], tasks), /^1\. 买牛奶（已完成）/);
  assert.deepEqual(result(requests[11], "list").tasks, [completed]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [completed]);
});

test("按展示顺序定位第二项，并使用同一 UUID 删除刚完成的任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶", { dueAt: "2026-12-02" });
  const parcel = tasks.create("取快递", { dueAt: "2026-12-01" });
  const book = tasks.create("还书");
  const list = completion(null, call("list", "list_tasks", {}));
  const requests = mockModel(t, (request, index) => {
    if (index === 0) return completion(null, call("list", "list_tasks", { sort: "due" }));
    if (index === 1) return completion(null);
    if (index === 2 || index === 5) return list;
    if (index === 3 || index === 6) {
      const previous = request.messages[index === 3 ? 2 : 4];
      assert.ok(previous?.role === "assistant" && typeof previous.content === "string");
      const visibleTitle = previous.content.match(
        index === 3 ? /^2\. (.+?)（(?:未完成|已完成)）/m : /「(.+)」/,
      )?.[1];
      const items: { id: string; title: string }[] = result(request, "list").tasks;
      const task_id = items.find((task) => task.title === visibleTitle)?.id;
      const name = index === 3 ? "complete_task" : "delete_task";
      return completion(null, call("change", name, { task_id }));
    }
    return completion(result(request, "change").message);
  });

  const history = [user("按截止日期列出清单")];
  const listed = await reply(history, tasks);
  assert.match(
    listed,
    /^1\. 取快递（未完成）[^\n]*\n2\. 买牛奶（未完成）[^\n]*\n3\. 还书（未完成）/,
  );
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
  assert.match(await reply([user("帮我记一下")], tasks), /请告诉我你想记下什么/);
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

test("模拟模型使用用户时区创建截止时间，并用任务 ID 修改优先级和工作量", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const now = new Date("2026-11-25T23:30:00Z");
  const context = { now, timeZone: "Europe/Paris" };
  const requests = mockModel(t, (request, index) => {
    if (index === 0) {
      assert.match(String(request.messages[0].content), /2026-11-26T00:30（Europe\/Paris）/);
      return completion(
        null,
        call("meeting", "create_task", { title: "开会", dueAt: "2026-11-27T15:00" }),
      );
    }
    if (index === 2) {
      return completion(
        null,
        call("report", "create_task", { title: "交报告", dueAt: "2026-11-27" }),
      );
    }
    if (index === 4) {
      return completion(
        null,
        call("details", "update_task", {
          task_id: tasks.list()[1].id,
          priority: "高",
          effort: "小",
        }),
      );
    }
    const id = index === 1 ? "meeting" : index === 3 ? "report" : "details";
    return completion(result(request, id).message);
  });
  await reply([user("明天下午三点开会")], tasks, context);
  await reply([user("周五交报告")], tasks, context);
  await reply([user("把报告设为高优先级，工作量设为小")], tasks, context);
  const meeting = result(requests[1], "meeting").task;
  const report = result(requests[3], "report").task;
  assert.equal(meeting.dueAt, "2026-11-27T14:00:00.000Z");
  assert.equal(report.dueAt, "2026-11-27");
  assert.deepEqual(createJsonTaskStore(filename).list(), [
    meeting,
    { ...report, priority: "高", effort: "小" },
  ]);
});

test("模型用父任务 ID 建立子任务，查询进度，并拦截删除仍有子任务的主任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const trip = tasks.create("准备法国旅行");
  const instructions = [
    call("flight", "create_task", { title: "订机票", parentId: trip.id }),
    call("hotel", "create_task", { title: "预订酒店", parentId: trip.id }),
    call("finish", "complete_task", {}),
    call("children", "list_tasks", { parentId: trip.id }),
    call("blocked", "delete_task", { task_id: trip.id }),
    call("remove", "delete_task", {}),
  ];
  const requests = mockModel(t, (request, index) => {
    const step = instructions[Math.floor(index / 2)];
    if (index % 2 !== 0) return completion(result(request, step.id).message);
    if (step.id === "finish" || step.id === "remove") {
      const title = step.id === "finish" ? "订机票" : "预订酒店";
      return completion(
        null,
        call(step.id, step.function.name, {
          task_id: tasks.list().find((item) => item.title === title)?.id,
        }),
      );
    }
    return completion(null, step);
  });
  for (const text of ["加子任务订机票", "加子任务预订酒店", "机票订好了", "旅行准备进度如何？"]) {
    await reply([user(text)], tasks);
  }
  const [parent, flight, hotel] = tasks.list();
  assert.deepEqual(parent, trip);
  assert.equal(flight.parentId, trip.id);
  assert.equal(flight.done, true);
  assert.equal(hotel.parentId, trip.id);
  assert.equal(hotel.done, false);
  assert.deepEqual(result(requests[7], "children").stats, {
    total: 2,
    done: 1,
    pending: 1,
    percent: 50,
  });
  assert.match(await reply([user("删除准备法国旅行")], tasks), /还有子任务/);
  assert.deepEqual(tasks.list(), [trip, flight, hotel]);
  await reply([user("只删除预订酒店这项")], tasks);
  assert.deepEqual(createJsonTaskStore(filename).list(), [trip, flight]);
});

test("模型按用户时区查询今天到期、已逾期和未来任务", async (t) => {
  const { tasks } = await temporaryStore(t);
  const past = tasks.create("昨天到期", { dueAt: "2026-11-25" });
  const today = tasks.create("今天到期", { dueAt: "2026-11-26" });
  const upcoming = tasks.create("明天到期", { dueAt: "2026-11-27" });
  const finished = tasks.create("已完成的旧任务", { dueAt: "2026-11-24" });
  tasks.update(finished.id, { done: true });
  tasks.create("没有日期");
  const context = { now: new Date("2026-11-25T23:30:00Z"), timeZone: "Europe/Paris" };
  const filters = ["today", "overdue", "future"];
  const requests = mockModel(t, (_request, index) =>
    index % 2 === 0
      ? completion(null, call("due", "list_tasks", { due: filters[index / 2] }))
      : completion("查询完毕"),
  );
  for (const text of ["今天到期的有哪些？", "有哪些逾期了？", "看看未来到期的任务"]) {
    await reply([user(text)], tasks, context);
  }
  assert.deepEqual(result(requests[1], "due").tasks, [today]);
  assert.deepEqual(result(requests[3], "due").tasks, [past]);
  assert.deepEqual(result(requests[5], "due").tasks, [upcoming]);
  assert.equal(tasks.list().length, 5);
});

test("同一请求中不同调用 ID 的重复新增复用已保存结果，不同消息可以新增同名任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const requests = mockModel(t, (_request, index) => {
    if (index === 0) return completion(null, call("first", "create_task", { title: "买牛奶" }));
    if (index === 1)
      return completion(null, call("retry", "create_task", '{ "title":" 买牛奶 " }'));
    if (index === 3) return completion(null, call("again", "create_task", { title: "买牛奶" }));
    return completion("已经添加了多条任务。");
  });
  const messages = [user("记下买牛奶")];
  const answer = await reply(messages, tasks);
  assert.equal(answer, "已添加待办「买牛奶」。");
  const [first] = createJsonTaskStore(filename).list();
  assert.deepEqual(createJsonTaskStore(filename).list(), [first]);
  assert.deepEqual(result(requests[1], "first"), result(requests[2], "retry"));
  assert.equal(result(requests[1], "first").task.id, first.id);

  messages.push({ role: "assistant", content: answer }, user("再添加一个买牛奶"));
  await reply(messages, tasks);
  const saved = createJsonTaskStore(filename).list();
  assert.deepEqual(
    saved.map(({ title }) => title),
    ["买牛奶", "买牛奶"],
  );
  assert.notEqual(saved[0].id, saved[1].id);
});

test("明确要求的多份同名任务与不同任务均能创建，重试不会多写", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  mockModel(t, (_request, index) =>
    index === 0
      ? completion(
          null,
          call("two", "create_task", { title: "买牛奶", count: 2 }),
          call("two-retry", "create_task", { title: "买牛奶", count: 2 }),
          call("other", "create_task", { title: "买面包" }),
        )
      : completion("全部添加成功。"),
  );

  assert.match(
    await reply([user("加两条相同的买牛奶，再加一条买面包")], tasks),
    /已添加 2 条待办「买牛奶」/,
  );
  const saved = createJsonTaskStore(filename).list();
  assert.deepEqual(
    saved.map(({ title }) => title),
    ["买牛奶", "买牛奶", "买面包"],
  );
  assert.equal(new Set(saved.map(({ id }) => id)).size, 3);
});

test("模型没有执行工具时，服务端不会确认新增、完成或删除", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const claims = ["已经完成了。", "我把它从清单拿掉啦！", "任务已经添加。"];
  const requests = mockModel(t, (_request, index) => completion(claims[Math.floor(index / 2)]));
  for (const text of ["完成买牛奶", "删除买牛奶", "添加买面包"]) {
    assert.match(await reply([user(text)], tasks), /本轮未执行任务操作/);
  }
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ tool_choice }) => tool_choice === "required"));
  assert.deepEqual(createJsonTaskStore(filename).list(), [milk]);
});

test("工具声称写入却未更新 JSON 时，服务端不采用模型的成功回复", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  t.mock.method(tasks, "update", () => ({ ...milk, done: true }));
  const requests = mockModel(t, (_request, index) =>
    index === 0
      ? completion(null, call("finish", "complete_task", { task_id: milk.id }))
      : completion("牛奶任务已经完成！"),
  );
  const answer = await reply([user("把买牛奶标记为完成")], tasks);
  assert.match(answer, /无法在任务存储中确认/);
  assert.doesNotMatch(answer, /已经完成/);
  assert.equal(result(requests[1], "finish").status, "conflict");
  assert.deepEqual(createJsonTaskStore(filename).list(), [milk]);
});

test("按展示后的清单删除第一项和第二项，空工具回复会重试", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶", { dueAt: "2026-11-30" });
  const parcel = tasks.create("取快递", { dueAt: "2026-11-29" });
  const book = tasks.create("还书");
  const done = tasks.create("寄信");
  tasks.update(done.id, { done: true });
  const deleting = call("first", "delete_task", { position: 1 });
  const requests = mockModel(t, (_request, index) => {
    switch (index) {
      case 0:
        return completion(null, call("pending", "list_tasks", { sort: "due", done: false }));
      case 2:
        return completion("已删除第一项。");
      case 3: {
        const response = completion(null, deleting);
        response.choices[0].finish_reason = "stop";
        return response;
      }
      case 5:
        return completion(null, call("second", "delete_task", { position: 2 }));
      default:
        return completion(null);
    }
  });
  const send = chat(tasks);
  const pending = await send("我还有哪些事情没做？");
  assert.deepEqual(pending.taskContext?.listed, [parcel.id, milk.id, book.id]);
  assert.match(pending.reply, /^1\. 取快递（未完成）/);
  assert.doesNotMatch(pending.reply, /寄信/);
  assert.match((await send("删除第一项任务")).reply, /已删除待办「取快递」/);
  assert.equal(requests[2].tool_choice, "required");
  assert.equal(requests[3].tool_choice, "required");
  assert.deepEqual(requests[4].messages.at(-2), {
    role: "assistant",
    content: null,
    tool_calls: [deleting],
  });
  assert.equal(result(requests[4], "first").task.id, parcel.id);
  assert.match((await send("把第二项去掉")).reply, /已删除待办「买牛奶」/);
  assert.equal(result(requests[6], "second").task.id, milk.id);
  assert.deepEqual(createJsonTaskStore(filename).list(), [book, { ...done, done: true }]);
});

test("最近添加和最近提到的任务通过聊天上下文定位", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const book = tasks.create("还书");
  const requests = mockModel(t, (_request, index) => {
    switch (index) {
      case 0:
        return completion(null, call("add", "create_task", { title: "买牛奶" }));
      case 2:
        return completion(
          null,
          call("show", "list_tasks", { title_query: "还书", purpose: "show" }),
        );
      case 4:
        return completion(null, call("delete-created", "delete_task", { recent: "created" }));
      case 6:
        return completion(
          null,
          call("mention", "list_tasks", { title_query: "还书", purpose: "show" }),
        );
      case 8:
        return completion(null, call("delete-mentioned", "delete_task", { recent: "mentioned" }));
      default:
        return completion(null);
    }
  });
  const send = chat(tasks);
  const added = await send("帮我记一下买牛奶");
  const [milkId] = added.taskContext?.created ?? [];
  assert.ok(milkId);
  await send("看看还书那项");
  assert.match((await send("删除刚才添加的任务")).reply, /已删除待办「买牛奶」/);
  assert.equal(result(requests[5], "delete-created").task.id, milkId);
  assert.deepEqual(createJsonTaskStore(filename).list(), [book]);
  await send("看看还书那项");
  assert.match((await send("这件事我不打算做了，帮我从清单里去掉")).reply, /已删除待办「还书」/);
  assert.equal(result(requests[9], "delete-mentioned").task.id, book.id);
  assert.deepEqual(createJsonTaskStore(filename).list(), []);
});

test("明确完成意图在定位查询后继续执行，支持删除刚完成的任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const book = tasks.create("还书");
  const requests = mockModel(t, (request, index) => {
    switch (index) {
      case 0:
        return completion(
          null,
          call("find", "list_tasks", { title_query: "牛奶", purpose: "lookup" }),
        );
      case 1:
        return completion("买牛奶已经完成了。");
      case 2:
        return completion(
          null,
          call("complete", "complete_task", { task_id: result(request, "find").tasks[0].id }),
        );
      case 4:
        return completion(null, call("delete-completed", "delete_task", { recent: "completed" }));
      case 6:
        return completion(null, call("show", "list_tasks", {}));
      case 8:
        return completion(null, call("complete-first", "complete_task", { position: 1 }));
      default:
        return completion(null);
    }
  });
  const send = chat(tasks);
  assert.match((await send("牛奶买好了")).reply, /已标记完成「买牛奶」/);
  assert.equal(requests[1].tool_choice, "required");
  assert.equal(requests[2].tool_choice, "required");
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...milk, done: true }, book]);
  assert.match((await send("把刚才完成的任务删除")).reply, /已删除待办「买牛奶」/);
  assert.equal(result(requests[5], "delete-completed").task.id, milk.id);
  await send("查看清单");
  assert.match((await send("把第一项标记为完成")).reply, /已标记完成「还书」/);
  assert.equal(result(requests[9], "complete-first").task.id, book.id);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...book, done: true }]);
});

test("没有已展示清单时先确认序号，含义不明的取消不执行删除", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const requests = mockModel(t, (_request, index) => {
    if (index === 0) return completion(null, call("position", "delete_task", { position: 1 }));
    if (index === 2 || index === 4)
      return completion(null, call("cancel", "delete_task", { recent: "mentioned" }));
    return completion("任务已删除。");
  });
  const send = chat(tasks);
  const initial = await send("删除第一项任务");
  assert.match(initial.reply, /请确认下方清单/);
  assert.deepEqual(initial.taskContext?.listed, [milk.id]);
  assert.match((await send("这件事取消掉")).reply, /没有单独的取消状态/);
  assert.match((await send("取消删除这件事")).reply, /保留当前清单/);
  assert.equal(result(requests[1], "position").status, "clarification");
  assert.equal(result(requests[3], "cancel").status, "clarification");
  assert.equal(result(requests[5], "cancel").status, "clarification");
  assert.deepEqual(createJsonTaskStore(filename).list(), [milk]);
});

test("清单中的原任务已被替换时，不按同名标题删除新任务", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const old = tasks.create("买牛奶");
  mockModel(t, (_request, index) => {
    if (index === 0) return completion(null, call("old", "list_tasks", {}));
    if (index === 2) return completion(null, call("delete-old", "delete_task", { position: 1 }));
    return completion("已删除。");
  });
  const send = chat(tasks);
  assert.deepEqual((await send("看看清单")).taskContext?.listed, [old.id]);
  assert.equal(tasks.remove(old.id), true);
  const replacement = tasks.create(old.title);
  assert.notEqual(replacement.id, old.id);
  assert.match((await send("删除第一项任务")).reply, /找不到待办/);
  assert.deepEqual(createJsonTaskStore(filename).list(), [replacement]);
});

test("返回专门的追问，并拒绝生成被截断的工具调用", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  mockModel(t, (_request, index) => {
    if (index === 0)
      return completion(null, call("question", "clarify_task", { reason: "target" }));
    if (index === 1) return completion("成功！");
    const response = completion(null, call("unfinished", "delete_task", { task_id: milk.id }));
    response.choices[0].finish_reason = "length";
    return response;
  });
  assert.match(await reply([user("删一下")], tasks), /你指的是哪项任务/);
  assert.match(await reply([user("删除买牛奶")], tasks), /回复不完整/);
  assert.deepEqual(createJsonTaskStore(filename).list(), [milk]);
});

test("混合模式优先本地处理中文新增、属性、序号、指代和否定", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const requests = mockModel(t, () => {
    throw new Error("Unexpected model call");
  });
  const send = chat(tasks, { now: new Date("2026-11-26T12:00:00Z"), timeZone: "Europe/Paris" });
  const saved = () => createJsonTaskStore(filename).list();
  await send("帮我记一下周五买牛奶");
  await send("提醒我明天去超市");
  await send("帮我创建一个准备考试的任务");
  assert.deepEqual(
    saved().map(({ title, dueAt }) => [title, dueAt]),
    [
      ["买牛奶", "2026-11-27"],
      ["去超市", "2026-11-27"],
      ["准备考试", undefined],
    ],
  );
  assert.match((await send("再添加两个任务")).reply, /每条任务的内容/);
  assert.equal(saved().length, 3);
  await send("再添加两个任务：取快递、还书");
  await send("把取快递的优先级设为最高");
  await send("买牛奶这个任务比较紧急");
  await send("把准备考试的工作量设置为大");
  assert.deepEqual(
    saved().map(({ priority, effort }) => [priority, effort]),
    [
      ["高", undefined],
      [undefined, undefined],
      [undefined, "大"],
      ["高", undefined],
      [undefined, undefined],
    ],
  );
  assert.equal((await send("现在有什么待办任务？")).taskContext?.listed?.length, 5);
  await send("把第一项的截止日期改成明天下午三点");
  assert.equal(saved()[0].dueAt, "2026-11-27T14:00:00.000Z");
  for (const text of [
    "不要删除第一项任务",
    "牛奶还没买好",
    "看看待办，但不要删除第一项",
    "这件事我不打算做了",
  ]) {
    const before = saved();
    await send(text);
    assert.deepEqual(saved(), before);
  }
  await send("第二项我已经做完了");
  await send("删除刚才完成的任务");
  assert.deepEqual(
    saved().map(({ title, done }) => [title, done]),
    [
      ["买牛奶", false],
      ["准备考试", false],
      ["取快递", false],
      ["还书", false],
    ],
  );
  await send("牛奶买好了");
  assert.match((await send("给我看看已经完成的任务")).reply, /买牛奶（已完成）/);
  assert.equal(saved()[0].done, true);
  assert.equal(requests.length, 0);
});

test("无密钥模式支持子任务、截止查询和属性新增", async (t) => {
  setKey(t);
  const { tasks, filename } = await temporaryStore(t);
  const send = chat(tasks, { now: new Date("2026-11-26T12:00Z"), timeZone: "Europe/Paris" });
  await send("新增一个高优先级任务，准备考试");
  await send("给准备考试添加子任务：今天晚上八点复习、后天做练习");
  const [parent, review, exercise] = createJsonTaskStore(filename).list();
  assert.equal(parent.priority, "高");
  assert.equal(review.dueAt, "2026-11-26T19:00:00.000Z");
  assert.equal(exercise.dueAt, "2026-11-28");
  assert.deepEqual((await send("查看准备考试的子任务")).taskContext?.listed, [
    review.id,
    exercise.id,
  ]);
  assert.deepEqual((await send("今天有哪些任务到期？")).taskContext?.listed, [review.id]);
  assert.deepEqual((await send("查询未来到期的任务")).taskContext?.listed, [
    review.id,
    exercise.id,
  ]);
  assert.match((await send("删除准备考试")).reply, /还有子任务/);
  await send("把复习标记为完成");
  assert.deepEqual(createJsonTaskStore(filename).list(), [
    parent,
    { ...review, done: true },
    exercise,
  ]);
  tasks.create("补交作业", { dueAt: "2026-11-25" });
  assert.match((await send("有哪些任务已经逾期？")).reply, /补交作业/);
});

test("复杂请求区分模型故障，随后明确指令仍可在本地执行", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const errors = [
    new OpenAI.APIError(401, { message: "internal test detail" }, undefined, new Headers()),
    new OpenAI.APIError(402, { message: "internal test detail" }, undefined, new Headers()),
    new OpenAI.APIError(429, { message: "internal test detail" }, undefined, new Headers()),
    new OpenAI.APIError(503, { message: "internal test detail" }, undefined, new Headers()),
    new OpenAI.APIConnectionError({ message: "internal test detail" }),
  ];
  const requests = mockModel(t, (_request, index) => {
    throw errors[index];
  });
  for (const hint of [/认证失败/, /余额不足/, /过于频繁/, /服务暂时异常/, /无法连接/]) {
    const { reply: answer } = await replyTurn(
      [user("根据我最近的目标帮我安排一下接下来要做的事")],
      tasks,
    );
    assert.match(answer, hint);
    assert.doesNotMatch(answer, /internal test detail/);
  }
  assert.deepEqual(tasks.list(), []);
  await replyTurn([user("帮我记一下买牛奶")], tasks);
  assert.equal(requests.length, errors.length);
  assert.deepEqual(
    createJsonTaskStore(filename)
      .list()
      .map(({ title }) => title),
    ["买牛奶"],
  );
});

test("混合模式将复杂指令交给模型，并拦截错误的否定指令写入", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const requests = mockModel(t, (_request, index) => {
    if (index === 0)
      return completion(
        null,
        call("flight", "create_task", { title: "订机票" }),
        call("hotel", "create_task", { title: "预订酒店" }),
      );
    if (index === 2)
      return completion(null, call("denied", "delete_task", { task_id: tasks.list()[0].id }));
    return completion("操作成功。");
  });
  const complex = await replyTurn([user("帮我把旅行准备拆成两项：订机票；预订酒店")], tasks);
  assert.match(complex.reply, /已添加待办「订机票」[\s\S]*已添加待办「预订酒店」/);
  const saved = createJsonTaskStore(filename).list();
  assert.deepEqual(
    saved.map(({ title }) => title),
    ["订机票", "预订酒店"],
  );
  const refused = await reply([user("先列出任务，但不要删除订机票")], tasks);
  assert.match(refused, /保留当前清单/);
  assert.equal(result(requests[3], "denied").status, "clarification");
  assert.deepEqual(createJsonTaskStore(filename).list(), saved);
});

test("带中英文引号的任务标题按完整标题删除，无引号仍按清单序号删除", async (t) => {
  setKey(t);
  for (const quoted of ["「第一项」", "“第一项”", '"第一项"', "'第一项'"]) {
    const { tasks, filename } = await temporaryStore(t);
    const milk = tasks.create("买牛奶");
    const literal = tasks.create("第一项");
    const other = tasks.create("第一项补充说明");
    const send = chat(tasks);
    const listed = await send("我有哪些任务？");
    assert.deepEqual(listed.taskContext?.listed, [milk.id, literal.id, other.id]);
    const literalDeletion = await send(`删除${quoted}`);
    assert.match(literalDeletion.reply, /已删除待办「第一项」/);
    assert.deepEqual(createJsonTaskStore(filename).list(), [milk, other]);
    const numberedDeletion = await send("删除第一项");
    assert.match(numberedDeletion.reply, /已删除待办「买牛奶」/);
    assert.deepEqual(createJsonTaskStore(filename).list(), [other]);
  }
});

test("完成工具拒绝否定、询问和假设语气，明确完成表达仍可写入", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const requests = mockModel(t, (_request, index) =>
    index % 2 === 0
      ? completion(null, call("complete", "complete_task", { task_id: milk.id }))
      : completion("已经完成买牛奶。"),
  );
  const blocked = [
    "我还没买好牛奶",
    "牛奶尚未买好",
    "牛奶没有完成",
    "买牛奶还没做好",
    "我不打算做这项任务",
    "暂时不做买牛奶",
    "不要完成买牛奶",
    "别标记为完成",
    "买牛奶已经完成了吗？",
    "我可能已经买好牛奶了",
    "我还剩哪些已完成任务",
    "如果我已经买好牛奶，该怎么办？",
  ];
  for (const [index, text] of blocked.entries()) {
    const answer = await reply([user(text)], tasks);
    assert.doesNotMatch(answer, /已标记完成|已经完成买牛奶/);
    assert.equal(result(requests[index * 2 + 1], "complete").status, "clarification", text);
    assert.deepEqual(createJsonTaskStore(filename).list(), [milk], text);
  }
  const done = await replyTurn([user("我已经买好牛奶了")], tasks);
  assert.match(done.reply, /已标记完成「买牛奶」/);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...milk, done: true }]);
  assert.equal(requests.length, blocked.length * 2);
});

test("逗号后的复合指令交给模型，新增和删除分别核对 JSON", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const parcel = tasks.create("取快递");
  const keep = tasks.create("还书");
  const saved = () => createJsonTaskStore(filename).list();
  const requests = mockModel(t, (request, index) => {
    if (index === 0) return completion(null, call("add", "create_task", { title: "买牛奶" }));
    if (index === 1) {
      const added = result(request, "add").task;
      assert.deepEqual(saved(), [parcel, keep, added]);
      return completion(null, call("remove", "delete_task", { task_id: parcel.id }));
    }
    assert.equal(result(request, "remove").task.id, parcel.id);
    return completion("全部完成。");
  });
  const answer = await replyTurn([user("帮我记一下买牛奶，再删除取快递。")], tasks);
  assert.equal(requests.length, 3);
  assert.match(answer.reply, /已添加待办「买牛奶」[\s\S]*已删除待办「取快递」/);
  assert.deepEqual(saved(), [keep, result(requests[1], "add").task]);
});

test("无密钥时不同类型的复合指令要求拆分，清单保持不变", async (t) => {
  setKey(t);
  const { tasks, filename } = await temporaryStore(t);
  const milk = tasks.create("买牛奶");
  const parcel = tasks.create("取快递");
  for (const text of [
    "帮我记一下买面包，再删除取快递",
    "帮我记一下买面包并删除取快递",
    "牛奶买好了，添加一条取信",
    "看看清单，把买牛奶的优先级设为高",
  ]) {
    assert.match((await replyTurn([user(text)], tasks)).reply, /拆成几条消息/);
    assert.deepEqual(createJsonTaskStore(filename).list(), [milk, parcel]);
  }
});

test("含糊的午夜不会写入，明确的中午和零点可以保存", async (t) => {
  const { tasks, filename } = await temporaryStore(t);
  const options = { now: new Date("2026-11-26T12:00Z"), timeZone: "Europe/Paris" };
  const requests = mockModel(t, (_request, index) =>
    index === 0
      ? completion(
          null,
          call("wrong-date", "create_task", { title: "交报告", dueAt: "2026-11-27T12:00" }),
        )
      : completion("任务已添加。"),
  );
  const input = [user("明天晚上十二点交报告。")];
  assert.match((await replyTurn(input, tasks, options)).reply, /确认具体日期/);
  assert.match(await reply(input, tasks, options), /确认具体日期/);
  assert.equal(result(requests[1], "wrong-date").status, "clarification");
  assert.deepEqual(createJsonTaskStore(filename).list(), []);

  await replyTurn([user("帮我记一下明天中午十二点交报告")], tasks, options);
  await replyTurn([user("帮我记一下后天00:00提交材料")], tasks, options);
  assert.deepEqual(
    createJsonTaskStore(filename)
      .list()
      .map(({ title, dueAt }) => [title, dueAt]),
    [
      ["交报告", "2026-11-27T11:00:00.000Z"],
      ["提交材料", "2026-11-27T23:00:00.000Z"],
    ],
  );
});
