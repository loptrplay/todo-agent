import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  parentTaskId,
  subtaskRelation,
  taskList,
  type Task,
  type TaskDetails,
} from "../shared/tasks.ts";

type TaskChanges = Partial<Pick<Task, "title" | "done">> & TaskDetails;
type CreateOptions = TaskDetails & { parentId?: string };

export class TaskConflict extends Error {}

export interface TaskStore {
  list(): Task[];
  create(title: string, options?: CreateOptions): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, options) {
      const items = list();
      if (
        options?.parentId !== undefined &&
        !items.some((item) => item.id === options.parentId && !parentTaskId(item))
      ) {
        throw new TaskConflict("主任务不存在，或指定的任务已经是子任务。");
      }
      const relationship = options?.parentId ? { taskRelation: subtaskRelation } : {};
      const task = { ...options, ...relationship, id: randomUUID(), title, done: false };
      save([...items, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      if (tasks.some((task) => parentTaskId(task) === id)) {
        throw new TaskConflict("这条主任务还有子任务。请先处理并删除子任务，再删除主任务。");
      }
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
