import * as v from "valibot";

// Домен трекера. Три сущности — проект → спринт → задача — плюс то, что вокруг них
// накапливается: лог задачи, дневник, отчёты, роли ментора и черновик разбора голосовухи.
//
// Календарные величины (`YYYY-MM-DD`, `HH:MM`) — всегда по Москве: система однопользовательская
// и живёт в одном поясе, поэтому день и время хранятся как есть, без пересчёта в UTC. Момент
// времени (`createdAt`, `at`) — наоборот, ISO-инстант в UTC: он не привязан к календарю.
// Разбор и форматирование — в `#src/domain/time.ts`.

/** Календарный день по Москве, `YYYY-MM-DD`. */
export const DaySchema = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));

/** Время суток по Москве, `HH:MM` (24 часа). */
export const TimeSchema = v.pipe(
  v.string(),
  v.regex(/^([01]\d|2[0-3]):[0-5]\d$/),
);

/** Момент времени — ISO-8601 в UTC. */
export const InstantSchema = v.pipe(v.string(), v.isoTimestamp());

export type Day = v.InferOutput<typeof DaySchema>;
export type Instant = v.InferOutput<typeof InstantSchema>;

// ─── Задача ────────────────────────────────────────────────────────────────────

/** Бэклог → в работе → сделана/убита. Дедлайнов и приоритетов в системе нет намеренно. */
export const TaskStatusSchema = v.picklist([
  "backlog",
  "doing",
  "done",
  "killed",
]);
export type TaskStatus = v.InferOutput<typeof TaskStatusSchema>;

/** Откуда пришло изменение — чтобы ментор понимал канал, а веб мог это показать. */
export const SourceSchema = v.picklist([
  "web",
  "telegram",
  "calendar",
  // Задача заведена правилом повторения, а не человеком: поздравление, регулярная проверка.
  "rule",
]);
export type Source = v.InferOutput<typeof SourceSchema>;

export const TaskSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  // Задача либо лежит в спринте, либо просто в проекте — оба варианта штатные.
  sprintId: v.nullable(v.string()),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  status: TaskStatusSchema,
  // День, на который задача выбрана явным кликом. Утренний список = задачи с этим днём.
  // Хранит день, а не булев флаг «на завтра»: иначе на рассвете флаг пришлось бы
  // перещёлкивать фоновым процессом, и пропуск прогона молча терял бы план.
  plannedFor: v.nullable(DaySchema),
  /** Понедельник календарной недели; `null` — задача вне недельного плана. */
  plannedWeek: v.optional(v.nullable(DaySchema)),
  // Напоминание: «Никита возвращается из Китая в августе» — в этот день бот пинает.
  remindOn: v.nullable(DaySchema),
  remindTime: v.nullable(TimeSchema),
  // Событие, жёстко привязанное ко времени (встреча, созвон). Попадает в день автоматически,
  // без явного клика — это единственное исключение из правила «в план только руками».
  eventOn: v.nullable(DaySchema),
  eventTime: v.nullable(TimeSchema),
  // Идентификатор события Google Calendar — чтобы повторная синхронизация обновляла, а не
  // плодила дубли. Заполняется интеграцией календаря (подключается позже).
  calendarEventId: v.nullable(v.string()),
  /** Правило, породившее задачу. `null` — задачу завёл человек. */
  recurrenceId: v.nullable(v.string()),
  /** Какое именно вхождение правила это задача. Вместе с `recurrenceId` — ключ идемпотентности. */
  occurrenceOn: v.nullable(DaySchema),
  routineId: v.optional(v.nullable(v.string())),
  createdAt: InstantSchema,
  doneAt: v.nullable(InstantSchema),
  source: SourceSchema,
});
export type Task = v.InferOutput<typeof TaskSchema>;

export interface Routine {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly createdAt: Instant;
}

export interface RoutineCheck {
  readonly id: string;
  readonly routineId: string;
  readonly day: Day;
  readonly done: boolean;
}

/** Запись лога задачи: что сделал, где застрял, чем закрыл. Это читает ментор при разборе. */
export const TaskLogSchema = v.object({
  id: v.string(),
  taskId: v.string(),
  at: InstantSchema,
  text: v.pipe(v.string(), v.trim(), v.minLength(1)),
  source: SourceSchema,
});
export type TaskLog = v.InferOutput<typeof TaskLogSchema>;

// ─── Проект и спринт ───────────────────────────────────────────────────────────

export const ProjectSchema = v.object({
  id: v.string(),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  note: v.string(),
  archived: v.boolean(),
  /**
   * Служебный проект — приёмник для того, что человек не заводил руками: напоминаний,
   * событий календаря, задач без проекта. В списке он уходит вниз и приглушается: смотреть
   * на него каждый день незачем, а удалить нельзя — иначе разбору речи некуда складывать.
   */
  system: v.boolean(),
  createdAt: InstantSchema,
});
export type Project = v.InferOutput<typeof ProjectSchema>;

// ─── Цель ─────────────────────────────────────────────────────────────────────

/** Горизонт цели. День начала однозначно задаёт конкретный месяц или год. */
export const GoalPeriodSchema = v.picklist(["month", "year"]);
export type GoalPeriod = v.InferOutput<typeof GoalPeriodSchema>;

/** Цель либо требует внимания, либо уже достигнута. */
export const GoalStatusSchema = v.picklist(["active", "done"]);
export type GoalStatus = v.InferOutput<typeof GoalStatusSchema>;

export const GoalSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  period: GoalPeriodSchema,
  /** Первое число месяца для `month`, первое января для `year`. */
  startsOn: DaySchema,
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(800)),
  completionCriterion: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(800),
  ),
  status: GoalStatusSchema,
  createdAt: InstantSchema,
  doneAt: v.nullable(InstantSchema),
});
export type Goal = v.InferOutput<typeof GoalSchema>;

/** Файл или зеркало гугл-таблицы — справочный материал, который ментор читает про проект. */
export const ProjectContextKindSchema = v.picklist(["file", "sheet"]);
export type ProjectContextKind = v.InferOutput<typeof ProjectContextKindSchema>;

/**
 * Элемент контекста БЕЗ тела: именно в таком виде он ездит в снапшоте. Тела файлов и таблиц —
 * сотни килобайт, и возить их на каждый показ экрана незачем.
 */
export const ProjectContextSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  kind: ProjectContextKindSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** Для таблицы — ссылка, как её дал человек. У файла пусто. */
  sourceUrl: v.string(),
  /** Длина текста: и список в вебе, и бюджет промпта считаются без чтения тела. */
  chars: v.pipe(v.number(), v.integer()),
  /**
   * Учитывать ли элемент. Пока агент не научился управлять контекстом сам, лишнее можно
   * выключить, не удаляя, — это дешёвый ответ на отложенный вопрос «что если контекста много».
   */
  enabled: v.boolean(),
  /** Когда последний раз перечитывали таблицу. У файла — `null`. */
  syncedAt: v.nullable(InstantSchema),
  createdAt: InstantSchema,
});
export type ProjectContext = v.InferOutput<typeof ProjectContextSchema>;

// ─── Контекст про владельца ────────────────────────────────────────────────────

/**
 * Заметка написана руками, файл приложен. Разница только в способе появления: в промпт оба
 * уходят одинаково, поэтому и живут в одном перечислении, а не в двух сущностях.
 */
export const OwnerContextKindSchema = v.picklist(["note", "file"]);
export type OwnerContextKind = v.InferOutput<typeof OwnerContextKindSchema>;

/**
 * Общий контекст про владельца — то, что подмешивается в КАЖДЫЙ промпт: и в разбор речи, и
 * в любой отчёт. Материалы проекта объясняют задачу, этот блок объясняет человека, поэтому
 * отбор по «затронутым проектам» на него не распространяется.
 *
 * Как и у контекста проекта, тело здесь не едет: заметка приходит в снапшоте отдельным полем
 * (её правят в поле ввода), тела файлов запрашиваются поштучно.
 */
export const OwnerContextSchema = v.object({
  id: v.string(),
  kind: OwnerContextKindSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  chars: v.pipe(v.number(), v.integer()),
  enabled: v.boolean(),
  createdAt: InstantSchema,
});
export type OwnerContext = v.InferOutput<typeof OwnerContextSchema>;

/** Спринт — список задач внутри проекта. По умолчанию неделя; можно планировать вперёд. */
export const SprintSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  title: v.pipe(v.string(), v.trim(), v.maxLength(120)),
  startsOn: DaySchema,
  endsOn: DaySchema,
  createdAt: InstantSchema,
});
export type Sprint = v.InferOutput<typeof SprintSchema>;

/** Стадия спринта выводится из дат, а не хранится: одна правда вместо двух. */
export type SprintPhase = "past" | "current" | "future";

// ─── Регулярные задачи ─────────────────────────────────────────────────────────

export const RecurFreqSchema = v.picklist([
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);
export type RecurFreq = v.InferOutput<typeof RecurFreqSchema>;

/** Как вхождение попадает в день: пинком, событием или сразу в план. */
export const RecurLandingSchema = v.picklist(["remind", "event", "plan"]);
export type RecurLanding = v.InferOutput<typeof RecurLandingSchema>;

/**
 * Правило повторения: заводится один раз и материализуется задачами вперёд. «Следующий
 * запуск» не хранится — даты вхождений считает чистая функция `occurrences` от `startsOn`,
 * поэтому пропущенный прогон планировщика ничего не теряет.
 */
export const RecurrenceSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  freq: RecurFreqSchema,
  startsOn: DaySchema,
  endsOn: v.nullable(DaySchema),
  landsAs: RecurLandingSchema,
  atTime: v.nullable(TimeSchema),
  /**
   * Ключ внешнего источника (`contact:<ключ>:birthday`). Апсерт по нему делает суточную
   * сверку с CRM идемпотентной: повторный прогон обновляет правило, а не заводит второе.
   */
  origin: v.nullable(v.string()),
  enabled: v.boolean(),
  createdAt: InstantSchema,
});
export type Recurrence = v.InferOutput<typeof RecurrenceSchema>;

// ─── Дневник ───────────────────────────────────────────────────────────────────

/** Вечерняя голосовуха «как прошёл день». Без неё вечерний отчёт не приходит. */
export const JournalEntrySchema = v.object({
  id: v.string(),
  day: DaySchema,
  at: InstantSchema,
  text: v.pipe(v.string(), v.trim(), v.minLength(1)),
  source: SourceSchema,
});
export type JournalEntry = v.InferOutput<typeof JournalEntrySchema>;

// ─── Ментор ────────────────────────────────────────────────────────────────────

/** Пять ролей задаются один раз в вебе; на каждый отчёт выбирается случайная включённая. */
export const MentorRoleSchema = v.object({
  id: v.string(),
  slot: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
  name: v.pipe(v.string(), v.trim(), v.maxLength(80)),
  // Плашка роли — единственное, что меняется в промпте от отчёта к отчёту.
  persona: v.pipe(v.string(), v.trim(), v.maxLength(4000)),
  enabled: v.boolean(),
  /**
   * Основная роль — та, чьим голосом разбор приходит чаще прочих. Ровно одна на систему:
   * у наставника должно быть узнаваемое лицо, но полностью отказываться от смены голоса
   * не хочется — один и тот же день, рассказанный по-разному, читается по-разному.
   */
  primary: v.boolean(),
});
export type MentorRole = v.InferOutput<typeof MentorRoleSchema>;

export const ROLE_SLOTS = [1, 2, 3, 4, 5] as const;

// ─── Отчёты ────────────────────────────────────────────────────────────────────

export const ReportKindSchema = v.picklist([
  "morning",
  "evening",
  "weekly",
  "monthly",
]);
export type ReportKind = v.InferOutput<typeof ReportKindSchema>;

/** План/факт — сухая часть отчёта. Считается кодом, без ИИ: цифры должны быть точными. */
export const ReportFactsSchema = v.object({
  planned: v.number(),
  done: v.number(),
  killed: v.number(),
  /** Из запланированного осталось незакрытым. Никуда не переезжает — просто цифра. */
  carried: v.number(),
  doneTitles: v.array(v.string()),
  openTitles: v.array(v.string()),
  killedTitles: v.array(v.string()),
  events: v.array(v.string()),
  reminders: v.array(v.string()),
  birthdays: v.array(v.string()),
  /** Нечего было планировать на завтра — утренний отчёт это подсвечивает. */
  emptyPlan: v.boolean(),
});
export type ReportFacts = v.InferOutput<typeof ReportFactsSchema>;

export const ReportSchema = v.object({
  id: v.string(),
  kind: ReportKindSchema,
  /**
   * День, за/на который отчёт. Для недельного — понедельник этой недели, для месячного —
   * первое число месяца: так `(kind, day)` остаётся однозначным ключом периода.
   */
  day: DaySchema,
  roleName: v.string(),
  facts: ReportFactsSchema,
  /** Разбор от ментора. Пусто, если LLM недоступна — план/факт всё равно уходит. */
  mentorText: v.string(),
  createdAt: InstantSchema,
});
export type Report = v.InferOutput<typeof ReportSchema>;

// ─── Недельные отчёты по целям ────────────────────────────────────────────────

/**
 * Модель динамики выбирается по природе результата, а не по количеству закрытых задач.
 * Тип фиксируется внутри снимка: последующая правка цели не перепишет прошлый отчёт.
 */
export const GoalModelSchema = v.picklist([
  "numeric",
  "project",
  "system",
  "research",
  "composite",
]);
export type GoalModel = v.InferOutput<typeof GoalModelSchema>;

export const GoalTrajectorySchema = v.picklist([
  "on-track",
  "at-risk",
  "off-track",
  "unknown",
]);
export type GoalTrajectory = v.InferOutput<typeof GoalTrajectorySchema>;

export const GoalContributionSchema = v.picklist([
  "direct-result",
  "milestone",
  "leading-action",
  "learning",
  "maintenance",
  "unconfirmed",
]);
export type GoalContribution = v.InferOutput<typeof GoalContributionSchema>;

export const EvidenceCertaintySchema = v.picklist([
  "fact",
  "inference",
  "hypothesis",
  "unknown",
]);
export type EvidenceCertainty = v.InferOutput<typeof EvidenceCertaintySchema>;

export const GoalActionSchema = v.object({
  title: v.string(),
  /** Результат, путь, веха или показатель, к которому отнесено действие. */
  relation: v.string(),
  contribution: GoalContributionSchema,
  evidence: v.string(),
  certainty: EvidenceCertaintySchema,
  /** Идентификаторы строк сохранённого входного снимка, на которых держится вывод. */
  sourceRefs: v.array(v.string()),
});
export type GoalAction = v.InferOutput<typeof GoalActionSchema>;

export const GoalEvidenceSchema = v.object({
  label: v.string(),
  detail: v.string(),
  sourceKind: v.picklist([
    "goal",
    "task",
    "log",
    "journal",
    "report",
    "context",
    "link",
  ]),
  sourceId: v.string(),
  certainty: EvidenceCertaintySchema,
});
export type GoalEvidence = v.InferOutput<typeof GoalEvidenceSchema>;

export const GoalHistoryPointSchema = v.object({
  label: v.string(),
  /** Текст сохраняет единицы, диапазон и честную неизвестность без выдуманной точности. */
  actual: v.string(),
  required: v.string(),
  forecast: v.string(),
  evidence: v.string(),
});
export type GoalHistoryPoint = v.InferOutput<typeof GoalHistoryPointSchema>;

export const GoalPrioritySchema = v.object({
  action: v.string(),
  whyNow: v.string(),
  expectedContribution: v.string(),
  evidenceNextWeek: v.string(),
  risk: v.string(),
});
export type GoalPriority = v.InferOutput<typeof GoalPrioritySchema>;

/** Пять разных способов показать прогресс без универсального процента готовности. */
export const GoalProgressSchema = v.variant("kind", [
  v.object({
    kind: v.literal("numeric"),
    actual: v.string(),
    required: v.string(),
    forecast: v.string(),
    explanation: v.string(),
  }),
  v.object({
    kind: v.literal("project"),
    completed: v.array(v.string()),
    current: v.string(),
    next: v.string(),
    explanation: v.string(),
  }),
  v.object({
    kind: v.literal("system"),
    standard: v.string(),
    window: v.string(),
    observed: v.string(),
    explanation: v.string(),
  }),
  v.object({
    kind: v.literal("research"),
    closedQuestions: v.array(v.string()),
    testedHypotheses: v.array(v.string()),
    decisions: v.array(v.string()),
    explanation: v.string(),
  }),
  v.object({
    kind: v.literal("composite"),
    results: v.array(
      v.object({ label: v.string(), state: v.string(), evidence: v.string() }),
    ),
    explanation: v.string(),
  }),
]);
export type GoalProgress = v.InferOutput<typeof GoalProgressSchema>;

export const GoalReportInsightSchema = v.object({
  title: v.string(),
  detail: v.string(),
  evidence: v.string(),
  certainty: EvidenceCertaintySchema,
  goalIds: v.array(v.string()),
  sourceRefs: v.array(v.string()),
});
export type GoalReportInsight = v.InferOutput<typeof GoalReportInsightSchema>;

export const GoalReportOverviewSchema = v.object({
  weeklyOutcome: v.string(),
  nextFocus: v.string(),
  confirmedProgress: v.array(GoalReportInsightSchema),
  risks: v.array(GoalReportInsightSchema),
  activityWithoutResult: v.array(GoalReportInsightSchema),
  conflicts: v.array(GoalReportInsightSchema),
  dependencies: v.array(GoalReportInsightSchema),
  changeVsPreviousWeek: v.string(),
});
export type GoalReportOverview = v.InferOutput<typeof GoalReportOverviewSchema>;

const BriefOutcomeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(120),
);
const BriefActionSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(90),
);
const BriefDoneSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
);
const BriefReasonSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(120),
);

export const GoalActionMoveSchema = v.object({
  action: BriefActionSchema,
  doneWhen: BriefDoneSchema,
  why: BriefReasonSchema,
  goalIds: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(2)),
  certainty: EvidenceCertaintySchema,
  sourceRefs: v.pipe(v.array(v.string()), v.maxLength(4)),
});
export type GoalActionMove = v.InferOutput<typeof GoalActionMoveSchema>;

export const GoalActionRiskSchema = v.object({
  problem: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(110)),
  response: BriefDoneSchema,
  goalIds: v.pipe(v.array(v.string()), v.maxLength(3)),
  certainty: EvidenceCertaintySchema,
  sourceRefs: v.pipe(v.array(v.string()), v.maxLength(4)),
});
export type GoalActionRisk = v.InferOutput<typeof GoalActionRiskSchema>;

export const GoalActionStopSchema = v.object({
  text: BriefActionSchema,
  why: BriefReasonSchema,
  certainty: EvidenceCertaintySchema,
  sourceRefs: v.pipe(v.array(v.string()), v.maxLength(4)),
});
export type GoalActionStop = v.InferOutput<typeof GoalActionStopSchema>;

/** Короткая неизменяемая проекция полного отчёта: решение сначала, доказательства по запросу. */
export const GoalActionBriefSchema = v.object({
  sourceReportId: v.string(),
  generatedAt: InstantSchema,
  outcome: BriefOutcomeSchema,
  moves: v.pipe(v.array(GoalActionMoveSchema), v.minLength(1), v.maxLength(3)),
  risk: v.nullable(GoalActionRiskSchema),
  stopDoing: v.nullable(GoalActionStopSchema),
  generation: v.picklist(["complete", "fallback"]),
  generationNote: v.string(),
});
export type GoalActionBrief = v.InferOutput<typeof GoalActionBriefSchema>;

export const GoalProjectAnalysisSchema = v.object({
  projectId: v.string(),
  projectName: v.string(),
  goalIds: v.array(v.string()),
  weeklyOutcome: v.string(),
  goalStates: v.string(),
  actionsContribution: v.string(),
  resultChanges: v.string(),
  obstacles: v.string(),
  conflicts: v.string(),
  trajectory: GoalTrajectorySchema,
  nextWeekPriorities: v.pipe(v.array(v.string()), v.maxLength(3)),
  evidence: v.array(GoalEvidenceSchema),
});
export type GoalProjectAnalysis = v.InferOutput<
  typeof GoalProjectAnalysisSchema
>;

export const GoalLinkKindSchema = v.picklist(["task-goal", "goal-goal"]);
export type GoalLinkKind = v.InferOutput<typeof GoalLinkKindSchema>;

export const GoalLinkDecisionSchema = v.picklist([
  "suggested",
  "confirmed",
  "rejected",
]);
export type GoalLinkDecision = v.InferOutput<typeof GoalLinkDecisionSchema>;

/** Предложение живёт в неизменяемом снимке, решение по нему — отдельно. */
export const GoalLinkProposalSchema = v.object({
  id: v.string(),
  kind: GoalLinkKindSchema,
  sourceId: v.string(),
  sourceLabel: v.string(),
  targetGoalId: v.string(),
  targetGoalLabel: v.string(),
  reason: v.string(),
  evidence: v.string(),
  certainty: EvidenceCertaintySchema,
  sourceRefs: v.array(v.string()),
});
export type GoalLinkProposal = v.InferOutput<typeof GoalLinkProposalSchema>;

export const GoalLinkStateSchema = v.object({
  id: v.string(),
  kind: GoalLinkKindSchema,
  sourceId: v.string(),
  targetGoalId: v.string(),
  decision: GoalLinkDecisionSchema,
  reason: v.string(),
  evidence: v.string(),
  createdAt: InstantSchema,
  decidedAt: v.nullable(InstantSchema),
});
export type GoalLinkState = v.InferOutput<typeof GoalLinkStateSchema>;

/** Весь экран одной цели — только данные сохранённого снимка, без текущего `Snapshot`. */
export const GoalWeeklyAnalysisSchema = v.object({
  goalId: v.string(),
  projectId: v.string(),
  projectName: v.string(),
  description: v.string(),
  completionCriterion: v.string(),
  model: GoalModelSchema,
  progress: GoalProgressSchema,
  state: v.object({
    trajectory: GoalTrajectorySchema,
    current: v.string(),
    weeklyChange: v.string(),
    forecast: v.string(),
    nextCheckpoint: v.string(),
  }),
  actions: v.array(GoalActionSchema),
  activitySummary: v.string(),
  resultSummary: v.string(),
  history: v.array(GoalHistoryPointSchema),
  previousRecommendationResult: v.string(),
  changeExplanation: v.string(),
  constraint: v.string(),
  recommendation: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
    v.maxLength(4),
  ),
  priorities: v.pipe(v.array(GoalPrioritySchema), v.maxLength(3)),
  unknowns: v.array(v.string()),
  evidence: v.array(GoalEvidenceSchema),
});
export type GoalWeeklyAnalysis = v.InferOutput<typeof GoalWeeklyAnalysisSchema>;

export const GoalReportSourceSchema = v.object({
  kind: v.picklist([
    "goals",
    "tasks",
    "logs",
    "journal",
    "reports",
    "context",
    "goal-links",
  ]),
  label: v.string(),
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type GoalReportSource = v.InferOutput<typeof GoalReportSourceSchema>;

export const GoalWeeklyReportSchema = v.object({
  id: v.string(),
  horizon: GoalPeriodSchema,
  periodStart: DaySchema,
  periodEnd: DaySchema,
  cutoffAt: InstantSchema,
  generatedAt: InstantSchema,
  historyFrom: v.nullable(DaySchema),
  headline: v.string(),
  sources: v.array(GoalReportSourceSchema),
  /** `partial` означает честный снимок без части ИИ-выводов, а не потерянный отчёт. */
  generation: v.picklist(["complete", "partial"]),
  generationNote: v.string(),
  overview: GoalReportOverviewSchema,
  projects: v.array(GoalProjectAnalysisSchema),
  goals: v.array(GoalWeeklyAnalysisSchema),
  suggestedLinks: v.array(GoalLinkProposalSchema),
});
export type GoalWeeklyReport = v.InferOutput<typeof GoalWeeklyReportSchema>;

export const GoalReportWeekSchema = v.object({
  horizon: GoalPeriodSchema,
  periodStart: DaySchema,
  periodEnd: DaySchema,
  generatedAt: InstantSchema,
});
export type GoalReportWeek = v.InferOutput<typeof GoalReportWeekSchema>;

/** Архив доступен либо по сессии владельца, либо по read-only capability из Телеграма. */
export const GoalReportArchiveSchema = v.object({
  horizon: GoalPeriodSchema,
  availableHorizons: v.array(GoalPeriodSchema),
  weeks: v.array(GoalReportWeekSchema),
  selected: v.nullable(GoalWeeklyReportSchema),
  brief: v.nullable(GoalActionBriefSchema),
  linkStates: v.array(GoalLinkStateSchema),
});
export type GoalReportArchive = v.InferOutput<typeof GoalReportArchiveSchema>;

// ─── Разбор голосовухи ─────────────────────────────────────────────────────────

/// Одно намерение, извлечённое из речи. Размеченное объединение — так и модель отвечает
/// однозначно, и исполнение сводится к `switch` без домысливания.

export const IntentSchema = v.variant("kind", [
  v.object({
    kind: v.literal("create-task"),
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
    /** Существующий проект. Если модель не нашла подходящий — `projectName`. */
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    /** Класть ли в текущий спринт проекта (задача «на эту неделю»). */
    intoCurrentSprint: v.optional(v.boolean()),
    /**
     * Завести и сразу закрыть. Нужно чаще, чем кажется: человек рассказывает про сделанное
     * дело, которого в трекере вообще не было («сегодня закрыл лендинг»). Без этого флага
     * такой рассказ было бы не выразить — `complete-task` требует существующей задачи.
     */
    done: v.optional(v.boolean()),
    log: v.optional(v.string()),
    plannedFor: v.optional(DaySchema),
    remindOn: v.optional(DaySchema),
    remindTime: v.optional(TimeSchema),
    eventOn: v.optional(DaySchema),
    eventTime: v.optional(TimeSchema),
  }),
  v.object({
    kind: v.literal("complete-task"),
    taskId: v.string(),
    log: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("kill-task"),
    taskId: v.string(),
  }),
  v.object({
    kind: v.literal("log-task"),
    taskId: v.string(),
    text: v.pipe(v.string(), v.trim(), v.minLength(1)),
    /** Взялся, но не закончил — переводим в «в работе». */
    start: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal("plan-task"),
    taskId: v.string(),
    day: DaySchema,
  }),
  v.object({
    kind: v.literal("remind-task"),
    taskId: v.string(),
    remindOn: DaySchema,
    remindTime: v.optional(TimeSchema),
  }),
  v.object({
    kind: v.literal("event-task"),
    taskId: v.string(),
    eventOn: DaySchema,
    eventTime: v.optional(TimeSchema),
  }),
  /**
   * Новый спринт. Даты обязательны обеими: «спринт на следующую неделю» модель разворачивает
   * в конкретный отрезок по календарю из запроса — считать его в коде было бы не проще, а
   * догадка «наверное, неделя» молча создавала бы спринт не на тот отрезок.
   */
  v.object({
    kind: v.literal("create-sprint"),
    /** Проект спринта. Как и у задачи: id из каталога либо имя, если такого проекта нет. */
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    title: v.optional(v.string()),
    startsOn: DaySchema,
    endsOn: DaySchema,
  }),
  /**
   * Переложить существующую задачу в спринт. Отдельно от `create-task.intoCurrentSprint`:
   * там спринт — свойство новой задачи, здесь — самостоятельное действие над старой.
   */
  v.object({
    kind: v.literal("sprint-task"),
    taskId: v.string(),
    /** Спринт из каталога. Пусто — берётся идущий спринт проекта задачи (или заводится). */
    sprintId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("journal"),
    text: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
]);
export type Intent = v.InferOutput<typeof IntentSchema>;

/** Что модель поняла из голосовухи. Показывается карточкой и ждёт подтверждения. */
export const DraftSchema = v.object({
  intents: v.array(IntentSchema),
  /** Одна строка от модели: что осталось непонятным или что она предположила. */
  note: v.string(),
});
export type Draft = v.InferOutput<typeof DraftSchema>;

export const CaptureStatusSchema = v.picklist([
  "pending",
  "applied",
  "cancelled",
]);
export type CaptureStatus = v.InferOutput<typeof CaptureStatusSchema>;

export const CaptureSchema = v.object({
  id: v.string(),
  at: InstantSchema,
  transcript: v.string(),
  draft: DraftSchema,
  status: CaptureStatusSchema,
  /** id сообщения-карточки в Телеграме — чтобы после применения отредактировать её. */
  chatMessageId: v.nullable(v.number()),
});
export type Capture = v.InferOutput<typeof CaptureSchema>;

// ─── Внешние источники ─────────────────────────────────────────────────────────

/** Контакт из CRM-таблицы. Обязательный юзкейс — дни рождения в утреннем отчёте. */
export const ContactSchema = v.object({
  id: v.string(),
  /**
   * Устойчивый ключ человека между прогонами синхронизации. Без него зеркало CRM
   * перезаписывалось бы целиком, и «появился новый человек» нельзя было бы отличить от
   * «прогон просто прошёл» — а на этом различии держится заведение поздравлений.
   */
  key: v.string(),
  name: v.string(),
  telegram: v.string(),
  /** `MM-DD`: год рождения для напоминания не нужен и часто неизвестен. */
  birthday: v.nullable(v.pipe(v.string(), v.regex(/^\d{2}-\d{2}$/))),
  note: v.string(),
  /** Когда человек впервые появился в зеркале — по нему видно, кто в CRM новый. */
  firstSeenAt: InstantSchema,
  syncedAt: InstantSchema,
});
export type Contact = v.InferOutput<typeof ContactSchema>;

// ─── Сводка для веба ───────────────────────────────────────────────────────────

/** Всё состояние трекера одним запросом: система личная, объёмы маленькие. */
export interface Snapshot {
  readonly routines?: readonly Routine[];
  readonly routineChecks?: readonly RoutineCheck[];
  readonly projects: readonly Project[];
  readonly goals: readonly Goal[];
  readonly sprints: readonly Sprint[];
  readonly tasks: readonly Task[];
  readonly logs: readonly TaskLog[];
  readonly recurrences: readonly Recurrence[];
  readonly contexts: readonly ProjectContext[];
  /** Заметка про владельца — целиком: её правят прямо в поле, а весит она килобайты. */
  readonly ownerNote: string;
  /** Приложенные материалы про владельца — без тел, как и контекст проекта. */
  readonly ownerFiles: readonly OwnerContext[];
  readonly today: Day;
  readonly tomorrow: Day;
}

export interface SessionInfo {
  readonly authorized: boolean;
}
