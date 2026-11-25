import { join } from "node:path";
import { replyTurn } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

const tasks = createJsonTaskStore(join("data", "tasks.json"));
const app = createApp({
  reply: (messages, timeZone) => replyTurn(messages, tasks, { timeZone }),
  tasks,
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(`小明智能体已启动：http://127.0.0.1:${address.port}`);
});
