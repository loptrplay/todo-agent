import { useState } from "react";
import {
  efforts,
  priorities,
  progress,
  readTaskDetails,
  type Task,
  type TaskFilters,
} from "../shared/tasks.ts";
import { boardSections, taskGroup } from "./task-board-model.ts";

function TaskMeta({ task, now, timeZone }: { task: Task; now: Date; timeZone: string }) {
  const { dueAt: date, priority, effort } = readTaskDetails(task);
  const group = taskGroup(task, now, timeZone);
  const label = date?.includes("T")
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(date))
    : date;
  return (
    <div className="task-meta">
      <span data-group={group}>{group === "已逾期" ? "已逾期 · 未完成" : group}</span>
      {date && <time dateTime={date}>{label}</time>}
      {priority && <span data-priority={priority}>{priority}优先级</span>}
      {effort && <span>工作量 {effort}</span>}
    </div>
  );
}

export function TaskBoard({
  tasks,
  error,
  loading,
  reload,
}: {
  tasks: Task[];
  error: string;
  loading: boolean;
  reload: () => void;
}) {
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<NonNullable<TaskFilters["priority"]> | "">("");
  const [effort, setEffort] = useState<NonNullable<TaskFilters["effort"]> | "">("");
  const [sort, setSort] = useState(false);
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stats = progress(tasks);
  const sections = boardSections(
    tasks,
    {
      search,
      priority: priority || undefined,
      effort: effort || undefined,
      sort: sort ? "due" : undefined,
    },
    now,
    timeZone,
  );

  return (
    <aside className="task-board" aria-labelledby="board-title">
      <div className="board-header">
        <h2 id="board-title">任务清单</h2>
        <button className="board-refresh" type="button" onClick={reload} disabled={loading}>
          刷新
        </button>
      </div>
      <dl className="board-stats">
        <div>
          <dt>总任务</dt>
          <dd>{stats.total}</dd>
        </div>
        <div>
          <dt>待办</dt>
          <dd>{stats.pending}</dd>
        </div>
        <div>
          <dt>已完成</dt>
          <dd>{stats.done}</dd>
        </div>
        <div>
          <dt>完成率</dt>
          <dd>{stats.percent}%</dd>
        </div>
      </dl>
      <div className="board-filters">
        <input
          type="search"
          aria-label="搜索任务"
          placeholder="搜索任务"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="按优先级筛选"
          value={priority}
          onChange={(event) => {
            const value = priorities.find((item) => item === event.target.value);
            setPriority(value ?? "");
          }}
        >
          <option value="">全部优先级</option>
          {priorities.map((value) => (
            <option key={value} value={value}>
              {value}优先级
            </option>
          ))}
        </select>
        <select
          aria-label="按工作量筛选"
          value={effort}
          onChange={(event) => {
            const value = efforts.find((item) => item === event.target.value);
            setEffort(value ?? "");
          }}
        >
          <option value="">全部工作量</option>
          {efforts.map((value) => (
            <option key={value} value={value}>
              工作量 {value}
            </option>
          ))}
        </select>
        <label className="board-sort">
          <input
            type="checkbox"
            checked={sort}
            onChange={(event) => setSort(event.target.checked)}
          />
          按截止日期
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && tasks.length === 0 && <p role="status">正在加载任务…</p>}
      {!loading && !error && sections.every(({ cards }) => cards.length === 0) && (
        <p className="board-empty">
          {tasks.length ? "没有符合条件的任务。" : "还没有任务，可在对话中添加。"}
        </p>
      )}
      {sections.map(({ group, cards }) => {
        if (!cards.length) return null;
        return (
          <section className="task-group" key={group}>
            <h3>{group}</h3>
            <ul>
              {cards.map(({ task, children, childStats }) => {
                return (
                  <li className="task-card" key={task.id}>
                    <strong>{task.title}</strong>
                    <TaskMeta task={task} now={now} timeZone={timeZone} />
                    {childStats.total > 0 && (
                      <div className="child-progress">
                        <progress
                          aria-label={`${task.title}子任务进度`}
                          max={childStats.total}
                          value={childStats.done}
                        />
                        <span>
                          {childStats.done}/{childStats.total}
                        </span>
                      </div>
                    )}
                    {children.length > 0 && (
                      <ul className="child-tasks">
                        {children.map((child) => (
                          <li key={child.id}>
                            <strong>{child.title}</strong>
                            <TaskMeta task={child} now={now} timeZone={timeZone} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
