import {
  dueStatus,
  parentTaskId,
  progress,
  selectTasks,
  type Task,
  type TaskFilters,
} from "../shared/tasks.ts";

export const taskGroups = ["已逾期", "今天到期", "待处理", "已完成"] as const;

export function taskGroup(task: Task, now: Date, timeZone: string) {
  if (task.done) return "已完成";
  const due = dueStatus(task, now, timeZone);
  if (due?.overdue) return "已逾期";
  return due?.today ? "今天到期" : "待处理";
}

export function boardSections(tasks: Task[], filters: TaskFilters, now: Date, timeZone: string) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    const parentId = parentTaskId(task);
    if (!parentId || !byId.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(task);
    children.set(parentId, siblings);
  }

  const visible = selectTasks(tasks, filters, now, timeZone);
  const visibleIds = new Set(visible.map(({ id }) => id));
  const roots = new Map<string, Task>();
  for (const task of tasks) {
    const parent = byId.get(parentTaskId(task) ?? "");
    const root = parent ?? task;
    if (visibleIds.has(task.id)) roots.set(root.id, root);
  }

  const sorting = { sort: filters.sort };
  const cards = selectTasks([...roots.values()], sorting, now, timeZone).map((task) => {
    const allChildren = children.get(task.id) ?? [];
    const statuses = new Set([task, ...allChildren].map((item) => taskGroup(item, now, timeZone)));
    return {
      task,
      group: taskGroups.find((group) => statuses.has(group)),
      children: selectTasks(
        allChildren.filter(({ id }) => visibleIds.has(id)),
        sorting,
        now,
        timeZone,
      ),
      childStats: progress(allChildren),
    };
  });
  return taskGroups.map((group) => ({
    group,
    cards: cards.filter((card) => card.group === group),
  }));
}
