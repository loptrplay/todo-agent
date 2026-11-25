import { chatResponseSchema, type ChatMessage } from "../shared/chat.ts";
import { taskList } from "../shared/tasks.ts";

export async function requestTasks(signal: AbortSignal) {
  const response = await fetch("/api/tasks", { signal });
  if (!response.ok) throw new Error("无法读取任务清单，请重试。");
  return taskList.parse(await response.json());
}

export async function requestReply(messages: ChatMessage[]) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  const body: unknown = await response.json();
  const answer = chatResponseSchema.safeParse(body);
  if (response.ok && answer.success) return answer.data;
  if (typeof body === "object" && body !== null) {
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}
