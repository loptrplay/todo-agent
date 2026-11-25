import { z } from "zod";
import { dateInZone } from "../shared/tasks.ts";

export class TaskDateError extends Error {}

export const midnightClarification =
  "晚上十二点处于两天交界，请确认具体日期，并用 00:00 表示午夜。";

export function mentionsAmbiguousMidnight(text: string) {
  return /(?:晚上|傍晚)\s*(?:十二|12)\s*(?:点|时|[:：]\d{2})/u.test(text);
}

export const modelDue = z
  .union([
    z.iso.date(),
    z.iso.datetime({ offset: true }),
    z.iso.datetime({ local: true, precision: -1 }),
  ])
  .nullable()
  .optional();

function wallTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(" ", "T");
}

export function localClock(now: Date, timeZone: string) {
  return `${wallTime(now, timeZone)}（${timeZone}）`;
}

export function normalizeDue(value: string | null | undefined, timeZone: string) {
  if (!value?.includes("T")) return value;
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return new Date(value).toISOString();
  const nominal = Date.parse(`${value}Z`);
  const offsets = new Set(
    [-1, 0, 1].map((day) => {
      const sample = nominal + day * 86_400_000;
      return Date.parse(`${wallTime(new Date(sample), timeZone)}Z`) - sample;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => new Date(nominal - offset))
    .filter((candidate) => wallTime(candidate, timeZone) === value);
  if (candidates.length !== 1) {
    throw new TaskDateError("这个本地时间不存在或有两个可能的时刻，请补充时区偏移或改用明确时间。");
  }
  return candidates[0].toISOString();
}

const digits = "零一二三四五六七八九";
export function chineseNumber(input: string): number {
  if (/^\d+$/.test(input)) return Number(input);
  const text = input.replace("两", "二");
  if (text.length === 1 && text !== "十") return digits.indexOf(text);
  const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  return match
    ? (match[1] ? digits.indexOf(match[1]) : 1) * 10 + (match[2] ? digits.indexOf(match[2]) : 0)
    : NaN;
}

export function readLocalDue(text: string, now: Date, timeZone: string) {
  const day =
    /^(今天|明天|后天|(?:(?:本|这|下)周|周|星期)[一二三四五六日天]|\d{4}-\d{2}-\d{2})/.exec(
      text,
    )?.[0];
  const rest = text.slice(day?.length ?? 0).trimStart();
  const time =
    /^(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:(\d{1,2})[:：](\d{2})|([零一二两三四五六七八九十\d]{1,3})点(?:钟)?\s*(半|一刻|三刻|[零一二两三四五六七八九十\d]{1,3}分)?)/.exec(
      rest,
    );
  if (!day && !time) return undefined;
  if (!day && time) throw new TaskDateError("请说明这个时刻是哪一天，例如明天下午三点。");
  if (!time && /^(凌晨|早上|上午|中午|下午|傍晚|晚上)/.test(rest)) {
    throw new TaskDateError("请补充具体时刻，例如下午三点。");
  }
  const date = new Date(`${dateInZone(now, timeZone)}T00:00:00Z`);
  if (day && !/^\d/.test(day)) {
    const relative = { 今天: 0, 明天: 1, 后天: 2 }[day];
    const weekday = "一二三四五六日".indexOf(day.at(-1) === "天" ? "日" : (day.at(-1) ?? ""));
    const mondayIndex = (date.getUTCDay() + 6) % 7;
    const difference = weekday - mondayIndex;
    const offset =
      relative ??
      (day.startsWith("下周")
        ? 7 + difference
        : /^(本|这)周/.test(day)
          ? difference
          : (difference + 7) % 7);
    date.setUTCDate(date.getUTCDate() + offset);
  }
  const dateText = day && /^\d/.test(day) ? day : date.toISOString().slice(0, 10);
  if (!z.iso.date().safeParse(dateText).success) throw new TaskDateError("请提供有效的截止日期。");
  if (!time) return { dueAt: dateText, rest };
  const [, period, numericHour, numericMinute, writtenHour, writtenMinute] = time;
  let hour = chineseNumber(numericHour ?? writtenHour);
  const minute = numericMinute
    ? Number(numericMinute)
    : writtenMinute === "半"
      ? 30
      : writtenMinute === "一刻"
        ? 15
        : writtenMinute === "三刻"
          ? 45
          : writtenMinute
            ? chineseNumber(writtenMinute.slice(0, -1))
            : 0;
  if (period && hour > 12) throw new TaskDateError("请确认时段和小时是否一致。");
  if ((period === "晚上" || period === "傍晚") && hour === 12)
    throw new TaskDateError(midnightClarification);
  if (/^(下午|傍晚|晚上|中午)$/.test(period ?? "") && hour < 12) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || !Number.isInteger(hour + minute)) {
    throw new TaskDateError("请提供有效的截止时间。");
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    dueAt: `${dateText}T${pad(hour)}:${pad(minute)}`,
    rest: rest.slice(time[0].length).trimStart(),
  };
}
