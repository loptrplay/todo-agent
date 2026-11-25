import { z } from "zod";

export const priorities = ["高", "中", "低"] as const;
export const efforts = ["小", "中", "大"] as const;
export const titleSchema = z.string().trim().min(1).max(200);
const dateOnly = z.iso.date();
const instant = z.iso.datetime({ offset: true }).transform((date) => new Date(date).toISOString());
export const taskDetails = z.strictObject({
  dueAt: z.union([dateOnly, instant]).nullish(),
  priority: z.enum(priorities).nullish(),
  effort: z.enum(efforts).nullish(),
});
export const storedTask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export const taskList = z.array(storedTask);
export type Task = z.infer<typeof storedTask>;
export type TaskDetails = z.infer<typeof taskDetails>;

// V1 allowed arbitrary extension fields. Interpret V2 values without rewriting old data.
export function readTaskDetails(task: Task): TaskDetails {
  return {
    dueAt: taskDetails.shape.dueAt.safeParse(task.dueAt).data,
    priority: taskDetails.shape.priority.safeParse(task.priority).data,
    effort: taskDetails.shape.effort.safeParse(task.effort).data,
  };
}

export const subtaskRelation = "todo-agent/v2-subtask";

export function parentTaskId(task: Task) {
  if (task.taskRelation !== subtaskRelation) return undefined;
  return typeof task.parentId === "string" && task.parentId ? task.parentId : undefined;
}

export function dateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function dueStatus(
  task: Task,
  now: Date,
  timeZone: string,
  today = dateInZone(now, timeZone),
) {
  const { dueAt } = readTaskDetails(task);
  if (!dueAt) return undefined;
  const timed = dueAt.includes("T");
  const date = timed ? dateInZone(new Date(dueAt), timeZone) : dueAt;
  return {
    today: date === today,
    overdue: timed ? Date.parse(dueAt) < now.getTime() : date < today,
    future: timed ? Date.parse(dueAt) > now.getTime() : date > today,
  };
}

export const dueFilters = ["today", "overdue", "future"] as const;
export type TaskFilters = {
  search?: string;
  priority?: TaskDetails["priority"];
  effort?: TaskDetails["effort"];
  due?: (typeof dueFilters)[number];
  sort?: "due";
};

export function selectTasks(tasks: Task[], filters: TaskFilters, now: Date, timeZone: string) {
  const search = filters.search?.trim().normalize("NFKC").toLowerCase();
  const today = dateInZone(now, timeZone);
  const match = tasks.filter(
    (task) =>
      (!search || task.title.normalize("NFKC").toLowerCase().includes(search)) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!filters.effort || task.effort === filters.effort) &&
      (!filters.due || (!task.done && dueStatus(task, now, timeZone, today)?.[filters.due])),
  );
  if (filters.sort === "due") {
    const keyed = match.map((task) => {
      const { dueAt } = readTaskDetails(task);
      const key = dueAt?.includes("T")
        ? `${dateInZone(new Date(dueAt), timeZone)}T${dueAt}`
        : (dueAt ?? "\uffff");
      return { task, key };
    });
    return keyed.sort((a, b) => a.key.localeCompare(b.key)).map(({ task }) => task);
  }
  return match;
}

export function progress(tasks: Task[]) {
  const total = tasks.length;
  const done = tasks.filter((task) => task.done).length;
  return {
    total,
    done,
    pending: total - done,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}
