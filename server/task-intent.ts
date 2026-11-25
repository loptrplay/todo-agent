import {
  chineseNumber,
  mentionsAmbiguousMidnight,
  midnightClarification,
  readLocalDue,
  TaskDateError,
} from "./task-dates.ts";

export type LocalStep = {
  tool: "create_task" | "list_tasks" | "complete_task" | "delete_task" | "update_task";
  args: Record<string, unknown>;
  titleLookup?: string;
  exactTitle?: boolean;
};
type Intent = { steps: LocalStep[] } | { message: string };

const step = (tool: LocalStep["tool"], args: LocalStep["args"] = {}): Intent => ({
  steps: [{ tool, args }],
});
const clarify = (message: string): Intent => ({ message });
const quotedTitle = (value: string) =>
  /^「([^」]+)」$|^“([^”]+)”$|^"([^"]+)"$|^'([^']+)'$/u
    .exec(value.trim())
    ?.slice(1)
    .find((item) => item !== undefined);
const unquote = (value: string) => quotedTitle(value) ?? value.trim();
const countPattern = "[\\d零一二两三四五六七八九十]+";
const withoutQuotedTitles = (text: string) =>
  text.replace(/「[^」]*」|“[^”]*”|"[^"]*"|'[^']*'/g, "【标题】");

export function ambiguousTaskMidnight(text: string) {
  return mentionsAmbiguousMidnight(withoutQuotedTitles(text));
}

export function deniesTaskChange(text: string) {
  const syntax = withoutQuotedTitles(text);
  return /(?:^|[，,；;。]|但是|但)\s*(?:请(?:先)?|先|还是)?(?:不要|别|不用|不必|不能|不想)\s*(?:先)?\s*(?:把.*?)?(?:删|去掉|移除|完(?:成|结)|标记|改|添|加|记)|^取消(?:刚才的?)?(?:删除|完成)|(?:还没|没(?:有)?|尚未)(?:做完|完成|[买取洗订寄交]好|处理好)(?:了)?[。！？!?]?$/u.test(
    syntax,
  );
}

function reference(value: string): Pick<LocalStep, "args" | "titleLookup" | "exactTitle"> {
  const literal = quotedTitle(value);
  if (literal !== undefined) return { args: {}, titleLookup: literal, exactTitle: true };
  const target = value.trim();
  const ordinal = new RegExp(
    `^第\\s*(${countPattern})\\s*(?:项|个|件)(?:任务|待办|事(?:情)?)?$`,
    "u",
  ).exec(target);
  if (ordinal) return { args: { position: chineseNumber(ordinal[1]) } };
  if (/^(?:刚才|刚刚)(?:新)?添加的(?:任务|待办)$/.test(target))
    return { args: { recent: "created" } };
  if (/^(?:刚才|刚刚)(?:标记为)?完成的(?:任务|待办)$/.test(target))
    return { args: { recent: "completed" } };
  if (
    /^(?:刚才(?:那个|那条|那项)|刚才提到的|(?:这|那)(?:件|项|个|条))(?:任务|待办|事(?:情)?)?$/.test(
      target,
    )
  ) {
    return { args: { recent: "mentioned" } };
  }
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target))
    return { args: { task_id: target } };
  return { args: {}, titleLookup: target.replace(/(?<=.)这(?:条|项)(?:任务|待办)?$/u, "") };
}

export function permitsTaskCompletion(text: string) {
  const syntax = withoutQuotedTitles(text);
  if (
    /(?:还没(?:有)?|尚未|没有|并未|没)\s*(?:做(?:好|完)|完成|处理好|[买取洗寄订交]好|办妥|搞定)|(?:不打算|暂时不|先不)\s*(?:做|完成)|(?:不要|别)\s*(?:完成|标记)/u.test(
      syntax,
    ) ||
    deniesTaskChange(text)
  )
    return false;
  const clauses = syntax.match(/[^，,。；;！!?？\n]+[?？]?/gu) ?? [];
  return clauses.some((part) => {
    const clause = part.trim();
    if (
      /^(?:(?:再|请|帮我|给我)\s*)*(?:如果|假如|要是|等到|是否|是不是|查看|看看|查询|列出|显示|(?:我(?:还[有剩]|有)|还有|有)?哪些)/u.test(
        clause,
      ) ||
      /可能|也许|大概|不确定|不清楚|不知道|似乎|好像|记不清/u.test(clause) ||
      /(?:吗|么|[?？])$/u.test(clause)
    )
      return false;
    return (
      /^(?:(?:再|请|帮我|麻烦)\s*)*(?:完成|做完)\s*\S|(?:标记|标成|设|设置)(?:为|成)?(?:已)?完成|(?:[买取洗寄订交]好|做完|完成|处理好|办妥|搞定)了$/u.test(
        clause,
      ) || /(?:已经|已)(?:[买取洗寄订交]好|做完|完成|处理好|办妥|搞定)/u.test(clause)
    );
  });
}

function clauseOperation(clause: string) {
  const command = clause.trim().replace(/^(?:(?:再|接着|然后|先|请|帮我|给我)\s*)+/u, "");
  if (/^(?:新增|添加|创建|记一下|记下|提醒我|记一条)/u.test(command)) return "create";
  if (/^(?:查(?:看|询)|看看|列出|显示)|^(?:我|现在|今天)?(?:还有|有)(?:哪些|什么)/u.test(command))
    return "list";
  if (/^(?:删除|删掉|移除)|(?:去掉|删掉|删除|移除)(?:吧)?$/u.test(command)) return "delete";
  if (/^(?:调整|修改|设置|更新)|(?:优先级|工作量|截止(?:日期|时间)).*(?:设|调|改)/u.test(command))
    return "update";
  if (permitsTaskCompletion(clause)) return "complete";
  return undefined;
}

export function isCompoundTaskRequest(text: string) {
  const clauses = withoutQuotedTitles(text).split(
    /[,，;；。\n]|然后|接着|同时|并且|之后再|顺便|(?:并|再)(?=把|删除|删掉|移除|新增|添加|创建|完成|标记|查询|查看|列出|调整|修改|设置)/u,
  );
  return new Set(clauses.map(clauseOperation).filter(Boolean)).size > 1;
}

function forTarget(tool: LocalStep["tool"], target: string, args: LocalStep["args"] = {}): Intent {
  const ref = reference(target);
  return { steps: [{ tool, ...ref, args: { ...args, ...ref.args } }] };
}

function newTask(text: string, now: Date, zone: string): Record<string, unknown> {
  if (quotedTitle(text) !== undefined) return { title: unquote(text) };
  const tagged = /^(.*?)\s*[,，]\s*(?:截止(?:日期|时间)?(?:为|到|是)?\s*)(.+)$/.exec(text);
  const parsed = readLocalDue(tagged ? tagged[2] : text, now, zone);
  if (tagged && (!parsed || parsed.rest)) throw new TaskDateError("请说明明确的截止日期或时刻。");
  return parsed
    ? { title: unquote(tagged?.[1] ?? parsed.rest), dueAt: parsed.dueAt }
    : { title: unquote(text) };
}

function newTasks(text: string, now: Date, zone: string): Intent | undefined {
  const priority =
    /^(?:帮我|请)?(?:新增|添加|创建)(?:一[个项条])?\s*(最高|最低|高|中|低)优先级(?:的)?(?:任务|待办)\s*[:：,，]\s*(.+)$/.exec(
      text,
    );
  if (priority)
    return step("create_task", {
      ...newTask(priority[2], now, zone),
      priority: priority[1].at(-1),
    });

  const batch = new RegExp(
    `^(?:帮我|请|再)?(?:添加|新增|创建)(${countPattern})[个条项](?:任务|待办)(?:\\s*[:：]\\s*(.*))?$`,
  ).exec(text);
  if (batch) {
    const count = chineseNumber(batch[1]);
    if (!batch[2]) return clarify("请告诉我每条任务的内容，可以用顿号分开。");
    const titles = batch[2]
      .split(/[、，,]/)
      .map((title) => title.trim())
      .filter(Boolean);
    if (titles.length !== count || count > 20)
      return clarify("请确认任务数量，并用顿号分开每条任务。");
    const items = new Map<string, Record<string, unknown>>();
    for (const title of titles) {
      const args = newTask(title, now, zone);
      const key = JSON.stringify(args);
      const previous = items.get(key);
      items.set(key, { ...args, count: previous ? Number(previous.count) + 1 : 1 });
    }
    return { steps: [...items.values()].map((args) => ({ tool: "create_task", args })) };
  }

  const newSubtasks = /^给(.+?)(?:新增|添加|创建)(?:一个|一条)?子任务\s*[:：]\s*(.+)$/.exec(text);
  if (newSubtasks) {
    return {
      steps: newSubtasks[2].split(/、/).map((title) => ({
        tool: "create_task",
        titleLookup: unquote(newSubtasks[1]),
        exactTitle: quotedTitle(newSubtasks[1]) !== undefined,
        args: newTask(title.trim(), now, zone),
      })),
    };
  }

  const named = /^(?:帮我|请)?(?:新增|添加|创建)(?:一个|一项|一条)?\s*(.+?)的(?:任务|待办)$/.exec(
    text,
  );
  const plain =
    /^(?:帮我记一下|帮我记下|记一下|记下|再记一条|提醒我|帮我添加(?:任务|待办)?|(?:再|请)?(?:新增|添加|创建)(?:一条|一个)?(?:任务|待办)?)\s*[:：]?\s*(.+)$/.exec(
      text,
    );
  const title = named?.[1] ?? plain?.[1];
  if (title?.trim()) return step("create_task", newTask(title.trim(), now, zone));
  return undefined;
}

export function localTaskIntent(input: string, now: Date, timeZone: string): Intent | undefined {
  const text = input
    .trim()
    .replace(/[。？！?!]+$/u, "")
    .trimEnd();
  const syntax = withoutQuotedTitles(text);
  if (deniesTaskChange(text)) {
    return clarify("我会保留当前清单。请明确告诉我需要执行哪项操作。");
  }
  if (ambiguousTaskMidnight(text)) return clarify(midnightClarification);
  // Complete-looking commands with multiple clauses go to the model rather than being partially applied.
  if (
    isCompoundTaskRequest(text) ||
    /[；;。！？?!\n]|然后|同时|并且|之后再|顺便|并(?:把|删除|添加|完成|查询)/u.test(syntax)
  )
    return undefined;

  const queryText = text.replace(/^(?:(?:再|请|帮我|给我)\s*)+/, "");
  if (
    /^(?:今天有(?:哪些|什么)(?:任务|事情)(?:要)?到期|(?:看看|查看|查询|列出)?今天(?:要)?到期的(?:任务|事情)|今天到期的(?:任务|事情)有(?:哪些|什么))$/.test(
      queryText,
    )
  )
    return step("list_tasks", { due: "today" });
  if (
    /^(?:有(?:哪些|什么)(?:任务|事情)(?:已经|已)?逾期|(?:看看|查看|查询|列出)?(?:已经|已)?逾期的任务)$/.test(
      queryText,
    )
  )
    return step("list_tasks", { due: "overdue" });
  if (/^(?:看看|查看|查询|列出)?未来(?:将)?到期的任务$/.test(queryText))
    return step("list_tasks", { due: "future" });
  const query =
    /^(?:看(?:一看|看|一下)?|查(?:看|询|一下)?|列(?:出|一下)?|显示|告诉我)?\s*(?:我(?:现在)?|现在)?(?:还(?:剩|有)|有)?(?:哪些|什么)?\s*(?:(?:已经完成|已完成|未完成|没做|待办|待处理)的?)?(?:任务|事情|清单|待办|事)(?:没做|未做)?$/u.test(
      queryText,
    );
  if (query && /(?:看|查|列|显示|告诉|有|什么|哪些)/.test(queryText)) {
    if (/已(?:经)?完成/.test(text)) return step("list_tasks", { done: true });
    return step("list_tasks", /未完成|待办|待处理|没做/.test(text) ? { done: false } : {});
  }
  const children =
    /^(?:请|帮我|给我)?(?:看看|看一下|查看|查询|列出)\s*(.+?)(?:下面|底下)?的子任务$/.exec(text);
  if (children) return forTarget("list_tasks", children[1]);

  const deletion =
    /^(?:请|帮我)?(?:删除|删掉|移除)\s*(.+?)(?:吧)?$/.exec(text) ??
    /^(?:请|帮我)?把(.+?)(?:从清单(?:里|中)?)(?:去掉|移除|移出|删掉|删除)(?:吧)?$/.exec(text) ??
    /^(?:请|帮我)?把(.+?)(?:去掉|删掉|删除)(?:吧)?$/.exec(text) ??
    /^(.+?)(?:这条|这一项)\s*删掉(?:吧)?$/.exec(text) ??
    /^(.+?)(?:我)?不打算做了[,，]\s*(?:请|帮我)?从清单(?:里|中)?(?:去掉|删掉|删除|移除)(?:吧)?$/.exec(
      text,
    );
  if (deletion) return forTarget("delete_task", deletion[1]);
  if (/^(?:取消|作废|撤销)|(?:取消(?:掉)?|不(?:打算)?做了)$/.test(syntax)) {
    if (!/^(?:提醒我|帮我记|记下|添加|新增|创建)/.test(syntax))
      return clarify("这项任务需要从清单删除，还是先保留？待办没有单独的取消状态。");
  }
  const completion =
    /^(?:请|帮我)?把(.+?)(?:标记|设)(?:为|成)?(?:已)?完成$/.exec(text) ??
    /^(.+?)(?:我)?(?:已经|已)?(?:做完|处理好|完成|办妥)了$/.exec(text);
  if (completion) return forTarget("complete_task", completion[1]);
  const finished = /^(?:我)?(?:已经|已)(买|取|洗|寄|订|交)好(.+?)了?$/u.exec(text);
  if (finished) return forTarget("complete_task", `${finished[1]}${finished[2]}`);
  const done = /^(.+?)(买|取|洗|寄|订|交)好了$/.exec(text);
  if (done) return forTarget("complete_task", `${done[2]}${done[1]}`);

  const priority =
    /^(?:请|帮我)?(?:把)?(.+?)(?:的|这(?:个|项)任务的?)?优先级(?:设(?:置)?为|调(?:到|成|为)?|改成)(最高|最低|高|中|低)$/.exec(
      text,
    );
  if (priority) return forTarget("update_task", priority[1], { priority: priority[2].at(-1) });
  const urgent = /^(.+?)(?:这个任务|这项任务|这条待办)(?:比较|很|非常)紧急$/.exec(text);
  if (urgent) return forTarget("update_task", urgent[1], { priority: "高" });
  const effort = /^(?:请|帮我)?(?:把)?(.+?)(?:的)?工作量(?:设(?:置)?为|改成|调成)(大|中|小)$/.exec(
    text,
  );
  if (effort) return forTarget("update_task", effort[1], { effort: effort[2] });
  const due =
    /^(?:请|帮我)?(?:把)?(.+?)(?:的)?截止(?:日期|时间)(?:改成|改为|设(?:置)?为|调到)(.+)$/.exec(
      text,
    );
  if (due) {
    const parsed = readLocalDue(due[2].trim(), now, timeZone);
    return parsed && !parsed.rest
      ? forTarget("update_task", due[1], { dueAt: parsed.dueAt })
      : undefined;
  }
  return newTasks(text, now, timeZone);
}
