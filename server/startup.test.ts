import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJsonTaskStore } from "./task-store.ts";

test("生产入口可启动，聊天与 REST 共用临时 JSON", { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "todo-agent-start-"));
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const env = { ...process.env, PORT: "0", DEEPSEEK_API_KEY: "", NODE_OPTIONS: "" };
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  t.after(async () => {
    child.kill();
    await exited;
    await rm(cwd, { recursive: true, force: true });
  });
  let error = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    error += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  let origin;
  for await (const line of lines) {
    origin = /http:\/\/127\.0\.0\.1:\d+/.exec(line)?.[0];
    if (origin) break;
  }
  assert.ok(origin, error || "入口没有报告监听地址");
  const chat = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "帮我记一下买牛奶" }] }),
  });
  assert.equal(chat.status, 200);
  const response = await fetch(`${origin}/api/tasks`);
  assert.equal(response.status, 200);
  const tasks = await response.json();
  assert.equal(tasks.length, 1);
  assert.deepEqual(createJsonTaskStore(join(cwd, "data", "tasks.json")).list(), tasks);
  assert.equal(tasks[0].title, "买牛奶");
});
