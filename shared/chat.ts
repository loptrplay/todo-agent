import { z } from "zod";

const taskIds = z.array(z.string().min(1).max(200));
const taskContextSchema = z.object({
  listed: taskIds.optional(),
  created: taskIds.optional(),
  completed: taskIds.optional(),
  mentioned: taskIds.optional(),
});

const content = z.string().trim().min(1);
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content }),
  z.object({ role: z.literal("assistant"), content, taskContext: taskContextSchema.optional() }),
]);

export const chatResponseSchema = z.object({
  reply: z.string(),
  taskContext: taskContextSchema.optional(),
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type TaskContext = z.infer<typeof taskContextSchema>;

export type ChatMessage = z.infer<typeof messageSchema>;

export const timeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });

export const chatRequestSchema = z.object({
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
  timeZone: timeZoneSchema.optional(),
});
