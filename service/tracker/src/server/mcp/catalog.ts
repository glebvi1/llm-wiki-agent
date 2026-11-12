import * as z from "zod/v4";

import { isDay } from "#src/domain/time.ts";

const id = z.string().min(1).max(200);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isDay);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const status = z.enum(["backlog", "doing", "done", "killed"]);
const title = z.string().trim().min(1).max(400);
const operationId = z
  .string()
  .min(8)
  .max(180)
  .describe(
    "Постоянный ключ поручения. При повторе сохраняй ТОТ ЖЕ ключ и ВСЕ прежние параметры. Для " +
      "другого действия нужен новый ключ.",
  );
const version = z
  .string()
  .regex(/^"\d+"$/)
  .describe(
    "Точное поле version из чтения объекта, вместе с кавычками. При конфликте перечитай и пересмотри решение.",
  );
const list = {
  q: z.string().optional(),
  projectId: id.optional(),
  status: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};
const task = {
  projectId: id,
  title,
  sprintId: id.nullable().optional(),
  status: status.optional(),
  plannedFor: day.nullable().optional(),
  plannedWeek: day
    .nullable()
    .optional()
    .describe(
      "Понедельник календарной недели. Дата автоматически определяет неделю; " +
        "для переноса в другую неделю явно передай новую дату или plannedFor:null и eventOn:null. " +
        "Снятие даты сохраняет неделю; plannedWeek:null снимает недельный план.",
    ),
  remindOn: day.nullable().optional(),
  remindTime: time.nullable().optional(),
  eventOn: day.nullable().optional(),
  eventTime: time.nullable().optional(),
};
const goal = {
  projectId: id,
  period: z.enum(["month", "year"]),
  startsOn: day,
  description: z.string().trim().min(1).max(800),
  completionCriterion: z.string().trim().min(1).max(800),
  status: z.enum(["active", "done"]).optional(),
};
const sprint = {
  projectId: id,
  startsOn: day,
  endsOn: day,
  title: z.string().max(120).optional(),
};
const recurrence = {
  projectId: id,
  title,
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  startsOn: day,
  endsOn: day.nullable().optional(),
  landsAs: z.enum(["remind", "event", "plan"]).optional(),
  atTime: time.nullable().optional(),
};
const file = {
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\r\n"/\\]+$/),
  contentBase64: z
    .string()
    .max(28_000_000)
    .refine(
      (value) => Buffer.from(value, "base64").toString("base64") === value,
      "неверный base64",
    )
    .optional()
    .describe(
      "Полное содержимое файла в base64. Сервер не читает пути на компьютере и не скачивает произвольные URL.",
    ),
  contentText: z
    .string()
    .max(20 * 1024 * 1024)
    .optional()
    .describe(
      "Полный текст UTF-8 файла .md или .txt. Укажи ровно одно из contentText/contentBase64.",
    ),
};

export interface TrackerTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: readonly string[];
  body?: readonly string[];
  upload?: boolean;
  verify?: string;
  collection?: boolean;
}

export const trackerTools: TrackerTool[] = [];

function read(
  name: string,
  description: string,
  path: string,
  shape: z.ZodRawShape = {},
  options: Partial<TrackerTool> = {},
) {
  trackerTools.push({
    name,
    description,
    path,
    method: "GET",
    schema: z.strictObject(shape),
    ...options,
  });
}

function write(
  name: string,
  description: string,
  method: TrackerTool["method"],
  path: string,
  shape: z.ZodRawShape,
  body: readonly string[],
  verify: string,
  upload = false,
) {
  trackerTools.push({
    name,
    description,
    method,
    path,
    schema: z
      .strictObject({ operationId, ...shape })
      .refine(
        (args) =>
          !upload ||
          ("contentText" in args && args.contentText !== undefined) !==
            ("contentBase64" in args && args.contentBase64 !== undefined),
        "Для файла укажи ровно одно из contentText/contentBase64",
      ),
    body,
    verify,
    upload,
  });
}

read(
  "get_snapshot",
  "Текущее состояние трекера по Москве: проекты, цели, спринты, задачи, комментарии, " +
    "повторения и контекст. Дневник и история читаются отдельно. Для изменения сначала прочитай " +
    "отдельный объект с version.",
  "/api/snapshot",
);

for (const [entity, label] of Object.entries({
  tasks: "задачи",
  projects: "проекты",
  goals: "цели",
  sprints: "спринты",
  logs: "комментарии задач",
  recurrences: "правила повторения",
  routines: "ежедневные рутины",
  "routine-checks": "отметки рутин",
})) {
  read(
    `list_${entity.replaceAll("-", "_")}`,
    `Найти ${label}. q — подстрока в любом поле. projectId и status фильтруются на ` +
      `сервере MCP. Ответ содержит total и nextOffset; при nextOffset продолжи чтение.`,
    `/api/${entity}`,
    list,
    { query: ["q"], collection: true },
  );
  read(
    `get_${entity.slice(0, -1).replaceAll("-", "_")}`,
    `Прочитать ${label} по постоянному id. Возвращает точную version для последующего изменения.`,
    `/api/${entity}/:id`,
    { id },
  );
}
read(
  "list_journal",
  "Полные записи дневника за включительный диапазон дней по Москве. q ищет подстроку " +
    "локально. Продолжай по nextOffset.",
  "/api/journal",
  { ...list, from: day.optional(), to: day.optional() },
  { query: ["from", "to"], collection: true },
);
read(
  "get_journal_entry",
  "Прочитать запись дневника и её version.",
  "/api/journal/:id",
  { id },
);
read(
  "get_week_plan",
  "Первоначальный и текущий план недели с version. week — понедельник. План недели — задачи " +
    "с plannedWeek этой недели. Дата определяет неделю автоматически, без даты задача видна в группе «Без дня».",
  "/api/plans/week/:week",
  { week: day },
);
read(
  "get_project_context",
  "Полный текст материала проекта. Для изменения используй get_context_revision.",
  "/api/context/:id",
  { id },
);
read(
  "get_owner_context",
  "Полный текст файла владельца. Для изменения используй get_context_revision.",
  "/api/owner/context/:id",
  { id },
);
read(
  "get_context_revision",
  "Согласованные полные records и version контекста. Для заметки владельца " +
    "entity=owner_context без id; для файла укажи id. Принимай решение по этим records.",
  "/api/wiki/revision",
  { entity: z.enum(["project_context", "owner_context"]), id: id.optional() },
  { query: ["entity", "id"] },
);
read(
  "export_history",
  "Страница исходного снимка/истории. Начни after=0; продолжай с cursor и теми же " +
    "until/capturedAt до complete=true. Следующую порцию начни с cursor без старых " +
    "until/capturedAt. Границы historyCoverage сохраняй.",
  "/api/wiki/export",
  {
    after: z.string().regex(/^\d+$/).default("0"),
    until: z.string().regex(/^\d+$/).optional(),
    capturedAt: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(2000).default(500),
  },
  { query: ["after", "until", "capturedAt", "limit"] },
);

function crud(
  entity: string,
  label: string,
  fields: z.ZodRawShape,
  patch: z.ZodRawShape = z.object(fields).partial().shape,
) {
  write(
    `create_${entity.slice(0, -1)}`,
    `Создать ${label}. Сохраняй operationId при повторе.`,
    "POST",
    `/api/${entity}`,
    fields,
    Object.keys(fields),
    `/api/${entity}/:resultId`,
  );
  write(
    `update_${entity.slice(0, -1)}`,
    `Изменить ${label}. Сначала get по id; version должна относиться к прочитанному ` +
      `состоянию. Пропущенное поле не меняется, null очищает разрешённое поле.`,
    "PATCH",
    `/api/${entity}/:id`,
    { id, version, ...patch },
    Object.keys(patch),
    `/api/${entity}/:id`,
  );
  write(
    `delete_${entity.slice(0, -1)}`,
    `Удалить ${label} по поручению пользователя. Удаление проекта каскадно удаляет ` +
      `задачи, цели, спринты и комментарии: для завершения проекта обычно используй ` +
      `archived=true.`,
    "DELETE",
    `/api/${entity}/:id`,
    { id, version },
    [],
    `/api/${entity}/:id`,
  );
}
crud("tasks", "задачу", task);
write(
  "create_routine",
  "Создать ежедневную рутину проекта. Все рутины доступны каждый день, отдельные задачи не материализуются.",
  "POST",
  "/api/routines",
  { projectId: id, name: z.string().trim().min(1).max(120) },
  ["projectId", "name"],
  "/api/routines/:resultId",
);
write(
  "update_routine",
  "Переименовать рутину или убрать в архив после get_routine. История отметок сохраняется.",
  "PATCH",
  "/api/routines/:id",
  {
    id,
    version,
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  },
  ["name", "archived"],
  "/api/routines/:id",
);
write(
  "set_routine_check",
  "Отметить или снять выполнение рутины за московский день. Сначала get_routine_check с id=<routineId>:<YYYY-MM-DD>; " +
    'для ещё не отмеченного дня version равна "0". Передай точную прочитанную version.',
  "PUT",
  "/api/routine-checks/:id",
  { id, version, routineId: id, day, done: z.boolean() },
  ["routineId", "day", "done"],
  "/api/routine-checks/:id",
);
crud(
  "projects",
  "проект",
  { name: z.string().trim().min(1).max(120), note: z.string().optional() },
  {
    name: z.string().trim().min(1).max(120).optional(),
    note: z.string().optional(),
    archived: z.boolean().optional(),
  },
);
crud("goals", "цель", goal);
crud(
  "sprints",
  "спринт",
  sprint,
  z.object(sprint).omit({ projectId: true }).partial().shape,
);
crud("recurrences", "правило повторения", recurrence, {
  ...z.object(recurrence).omit({ projectId: true }).partial().shape,
  enabled: z.boolean().optional(),
});
write(
  "create_log",
  "Добавить комментарий к задаче. Описания и ссылки задачи хранятся в комментариях.",
  "POST",
  "/api/tasks/:id/logs",
  { id, text: z.string().trim().min(1) },
  ["text"],
  "/api/logs/:resultId",
);
write(
  "update_log",
  "Исправить полный текст комментария после get_log.",
  "PATCH",
  "/api/logs/:id",
  { id, version, text: z.string().trim().min(1) },
  ["text"],
  "/api/logs/:id",
);
write(
  "delete_log",
  "Удалить комментарий по поручению пользователя после get_log.",
  "DELETE",
  "/api/logs/:id",
  { id, version },
  [],
  "/api/logs/:id",
);
write(
  "create_journal_entry",
  "Добавить полную запись дневника. По умолчанию сегодняшний день по Москве.",
  "POST",
  "/api/journal",
  { day: day.optional(), text: z.string().trim().min(1) },
  ["day", "text"],
  "/api/journal/:resultId",
);
write(
  "update_journal_entry",
  "Заменить дату и полный текст дневника после get_journal_entry.",
  "PATCH",
  "/api/journal/:id",
  { id, version, day, text: z.string().trim().min(1) },
  ["day", "text"],
  "/api/journal/:id",
);
write(
  "delete_journal_entry",
  "Удалить запись дневника по поручению пользователя после чтения.",
  "DELETE",
  "/api/journal/:id",
  { id, version },
  [],
  "/api/journal/:id",
);
write(
  "confirm_week_plan",
  "Задать ПОЛНЫЙ состав недельного плана после get_week_plan. Пустой taskIds допустим. Первое " +
    "подтверждение сохраняет неизменяемый первоначальный план. version берётся из " +
    "get_week_plan.",
  "POST",
  "/api/plans/week/confirm",
  { week: day, taskIds: z.array(id), version },
  ["week", "taskIds"],
  "/api/plans/week/:week",
);
write(
  "upload_project_file",
  "Загрузить полный файл в материалы проекта. Передай filename и contentText либо contentBase64.",
  "POST",
  "/api/projects/:id/context/file",
  { id, ...file },
  [],
  "/api/context/:resultId",
  true,
);
write(
  "attach_project_sheet",
  "Подключить Google-таблицу к материалам проекта по URL.",
  "POST",
  "/api/projects/:id/context/sheet",
  { id, url: z.url() },
  ["url"],
  "/api/context/:resultId",
);
write(
  "upload_owner_file",
  "Загрузить полный файл в контекст владельца.",
  "POST",
  "/api/owner/context/file",
  file,
  [],
  "/api/owner/context/:resultId",
  true,
);
write(
  "set_owner_note",
  "Заменить ПОЛНУЮ заметку владельца. Сначала get_context_revision(entity=owner_context) БЕЗ " +
    "id; используй его records и version.",
  "PUT",
  "/api/owner/note",
  { version, text: z.string().max(100_000) },
  ["text"],
  "/api/wiki/revision?entity=owner_context",
);
for (const [name, path] of [
  ["project", "/api/context"],
  ["owner", "/api/owner/context"],
]) {
  write(
    `set_${name}_context_enabled`,
    "Включить/выключить материал. version из get_context_revision с соответствующим entity и id.",
    "PATCH",
    `${path}/:id`,
    { id, version, enabled: z.boolean() },
    ["enabled"],
    `${path}/:id`,
  );
  write(
    `delete_${name}_context`,
    "Удалить материал по поручению пользователя. version из get_context_revision с " +
      "соответствующим entity и id.",
    "DELETE",
    `${path}/:id`,
    { id, version },
    [],
    `${path}/:id`,
  );
}
