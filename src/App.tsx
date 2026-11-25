import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/tasks.ts";
import { requestReply, requestTasks } from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskBoard } from "./TaskBoard.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState("");
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [taskVersion, setTaskVersion] = useState(0);
  const [mobileView, setMobileView] = useState<"chat" | "tasks">("chat");
  const input = useRef<HTMLTextAreaElement>(null);
  const reloadTasks = () => setTaskVersion((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingTasks(true);
    setTaskError("");
    void requestTasks(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setTasks(items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTaskError("无法读取任务清单，请刷新重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTasks(false);
      });
    return () => controller.abort();
  }, [taskVersion]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(outgoing);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([
        ...outgoing,
        { role: "assistant", content: answer.reply, taskContext: answer.taskContext },
      ]);
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      reloadTasks();
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span>小明智能体</span>
      </header>
      <nav className="workspace-switch" aria-label="工作区视图">
        <button
          type="button"
          aria-pressed={mobileView === "chat"}
          onClick={() => setMobileView("chat")}
        >
          对话
        </button>
        <button
          type="button"
          aria-pressed={mobileView === "tasks"}
          onClick={() => setMobileView("tasks")}
        >
          任务清单
        </button>
      </nav>
      <div className="workspace" data-mobile-view={mobileView}>
        <main>
          <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="输入消息…"
                rows={2}
                value={draft}
                readOnly={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行</small>
          </div>
        </main>
        <TaskBoard tasks={tasks} error={taskError} loading={loadingTasks} reload={reloadTasks} />
      </div>
    </div>
  );
}
