import type { ChatMessage } from "../shared/chat.ts";
import type { TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

export async function reply(messages: ChatMessage[], tasks: TaskStore): Promise<string> {
  const text = messages.at(-1)?.content ?? "";
  const question = text.replace(/[？?。！!]+$/, "").trim();
  if (question === "我有哪些任务" || question === "再给我看看清单") {
    const items = tasks.list();
    if (items.length === 0) return "你的清单目前是空的。";

    return items
      .map((task, index) => {
        const status = task.done ? "已完成" : "未完成";
        return `${index + 1}. ${task.title}（${status}）`;
      })
      .join("\n");
  }
  const completed = /^(.+?)(买|取|洗)好了$/.exec(question);
  const explicit = /^把(.+?)标记为已完成$/.exec(question);

  if (completed || explicit) {
    const title = completed ? `${completed[2]}${completed[1].trim()}` : explicit![1].trim();

    const matches = tasks.list().filter((task) => task.title === title);
    if (matches.length === 0) return `找不到待办「${title}」。`;
    if (matches.length > 1) return `有多条同名待办「${title}」，请先区分它们。`;

    const task = matches[0];
    if (task.done) return `「${task.title}」已经完成了。`;

    tasks.update(task.id, { done: true });
    return `已标记完成：${task.title}`;
  }
  const deletion = /^(.+?)这条删掉吧$/.exec(question) ?? /^删除\s*(.+)$/.exec(question);

  if (deletion) {
    const title = deletion[1].trim();
    const matches = tasks.list().filter((task) => task.title === title);

    if (matches.length === 0) return `找不到待办「${title}」。`;
    if (matches.length > 1) return `有多条同名待办「${title}」，请先区分它们。`;

    const task = matches[0];
    if (!tasks.remove(task.id)) return `找不到待办「${title}」。`;
    return `已删除待办：${task.title}`;
  }
  const match = /^(?:帮我记一下|再记一条)(.*)$/.exec(text);
  if (!match) return "你好，欢迎使用小明智能体";

  const title = match[1].trim();
  if (title.length < 1 || title.length > 200) {
    return "请提供 1 至 200 个字符的任务标题。";
  }

  const task = tasks.create(title);
  return `已添加待办：${task.title}`;
}
