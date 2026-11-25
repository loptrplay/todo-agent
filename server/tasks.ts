import { Router } from "express";
import { z } from "zod";
import { timeZoneSchema } from "../shared/chat.ts";
import { dueFilters, priorities, selectTasks, taskDetails, titleSchema } from "../shared/tasks.ts";
import { TaskConflict, type TaskStore } from "./task-store.ts";

const createTaskSchema = taskDetails.extend({
  title: titleSchema,
  parentId: titleSchema.optional(),
});
const updateTaskSchema = taskDetails
  .extend({ title: titleSchema.optional(), done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);
const listQuery = z.object({
  search: titleSchema.optional(),
  priority: z.enum(priorities).optional(),
  due: z.enum(dueFilters).optional(),
  sort: z.literal("due").optional(),
  timeZone: timeZoneSchema.optional(),
});

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    const input = listQuery.safeParse(_req.query);
    if (!input.success) return res.status(400).json({ error: "任务查询参数无效。" });
    const { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, ...filters } = input.data;
    res.json(selectTasks(tasks.list(), filters, new Date(), timeZone));
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请检查任务标题、截止日期、优先级和工作量。" });
    }
    const { title, ...options } = input.data;
    try {
      res.status(201).json(tasks.create(title, options));
    } catch (error) {
      if (error instanceof TaskConflict) return res.status(409).json({ error: error.message });
      throw error;
    }
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的任务修改字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    try {
      if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    } catch (error) {
      if (error instanceof TaskConflict) return res.status(409).json({ error: error.message });
      throw error;
    }
    res.sendStatus(204);
  });

  return router;
}
