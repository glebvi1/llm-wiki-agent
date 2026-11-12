import * as z from "zod/v4";

export const chatId = z.union([
  z.string().regex(/^-?\d{1,20}$/),
  z.number().int().transform(String),
]);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const operationId = z.string().min(8).max(180);
export const chatComment = z.string().trim().max(4000);

export const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["private", "group", "channel"]),
  username: z.string().optional(),
});

export const messageSchema = z.object({
  id: z.number().int().positive(),
  chatId: z.string(),
  sender: z.string(),
  senderId: z.string().nullable(),
  date: z.iso.datetime(),
  text: z.string(),
  edited: z.iso.datetime().nullable(),
  replyTo: z.number().int().positive().nullable(),
  topic: z.number().int().positive().nullable(),
  out: z.boolean(),
  media: z.string().nullable(),
  link: z.url().nullable(),
});

export const chatStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["private", "group", "channel"]),
  enabled: z.boolean(),
  comment: chatComment.default(""),
  importFrom: z.enum(["now", "date", "all"]),
  fromDate: day.nullable(),
  newestId: z.number().int().nonnegative(),
  oldestId: z.number().int().positive().nullable(),
  backfillComplete: z.boolean(),
  known: z.record(
    z.string(),
    z.object({
      hash: z.string(),
      edited: z.iso.datetime().nullable(),
      date: z.iso.datetime(),
    }),
  ),
  verifyOffset: z.number().int().nonnegative(),
  lastReceiveAt: z.iso.datetime().nullable(),
  lastProcessAt: z.iso.datetime().nullable(),
  completeThrough: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  gaps: z.array(z.string()),
});

export const sendOperationSchema = z.object({
  operationId,
  approvalId: z.string(),
  chatId: z.string(),
  text: z.string(),
  replyTo: z.number().int().positive().nullable(),
  status: z.enum(["prepared", "pending", "sent", "uncertain", "failed"]),
  createdAt: z.iso.datetime(),
  attemptAt: z.iso.datetime().nullable(),
  messageId: z.number().int().positive().nullable(),
  detail: z.string().nullable(),
});

const processingChatSchema = chatSchema
  .pick({ id: true, title: true, type: true })
  .extend({
    comment: chatComment,
  });
const processingChatsSchema = z.record(z.string(), processingChatSchema);

export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  chats: z.record(z.string(), chatStateSchema),
  sends: z.record(z.string(), sendOperationSchema),
  approvals: z.record(
    z.string(),
    z.object({
      operationId,
      chatId: z.string(),
      text: z.string(),
      replyTo: z.number().int().positive().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  processedBatches: z.record(z.string(), z.string()),
  completedRuns: z.record(z.string(), z.string()),
  runChatSettings: z.record(z.string(), processingChatsSchema).default({}),
  pendingQuestions: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      taskId: z.string().nullable(),
    }),
  ),
  activeRun: z
    .object({
      runId: z.string(),
      batches: z.array(z.object({ path: z.string(), sha256: z.string() })),
      startedAt: z.iso.datetime(),
      chatSettings: processingChatsSchema.optional(),
    })
    .nullable(),
});

export type Chat = z.infer<typeof chatSchema>;
export type TelegramMessage = z.infer<typeof messageSchema>;
export type ChatState = z.infer<typeof chatStateSchema>;
export type SendOperation = z.infer<typeof sendOperationSchema>;
export type WikiState = z.infer<typeof stateSchema>;

export function emptyState(): WikiState {
  return {
    schemaVersion: 1,
    chats: {},
    sends: {},
    approvals: {},
    processedBatches: {},
    completedRuns: {},
    runChatSettings: {},
    pendingQuestions: [],
    activeRun: null,
  };
}

export function chatFromUpstream(value: unknown): Chat {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const kind = z.string().parse(row.type).toLowerCase();
  const type = kind.includes("channel")
    ? "channel"
    : kind.includes("group") || kind.includes("chat")
      ? "group"
      : "private";
  const id = z.union([z.string(), z.number()]).parse(row.chat_id);
  const title = z.string().parse(row.title ?? row.name ?? id);
  const username = z.string().optional().parse(row.username);
  return chatSchema.parse({
    id: String(id),
    title,
    type,
    ...(username ? { username } : {}),
  });
}

export function messageFromUpstream(
  chatIdValue: string,
  value: unknown,
  chatUsername?: string,
): TelegramMessage {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const id = z.number().int().positive().parse(row.id);
  const date = upstreamDate(row.date);
  const edited =
    row.edited === undefined || row.edited === null
      ? null
      : upstreamDate(row.edited);
  const link = chatUsername
    ? `https://t.me/${chatUsername}/${String(id)}`
    : chatIdValue.startsWith("-100")
      ? `https://t.me/c/${chatIdValue.slice(4)}/${String(id)}`
      : null;
  const senderId =
    row.sender_id === undefined || row.sender_id === null
      ? null
      : String(z.union([z.string(), z.number()]).parse(row.sender_id));
  return messageSchema.parse({
    id,
    chatId: String(
      z.union([z.string(), z.number()]).parse(row.chat_id ?? chatIdValue),
    ),
    sender: z.string().optional().parse(row.sender) ?? "Неизвестный автор",
    senderId,
    date,
    text: z.string().optional().parse(row.text) ?? "",
    edited: edited ?? null,
    replyTo:
      z.number().int().positive().nullable().optional().parse(row.reply_to) ??
      null,
    topic:
      z.number().int().positive().nullable().optional().parse(row.topic) ??
      null,
    out: z.boolean().optional().parse(row.out) ?? false,
    media: z.string().nullable().optional().parse(row.media) ?? null,
    link,
  });
}

export function moscowDayStart(value: string): string {
  return new Date(`${value}T00:00:00+03:00`).toISOString();
}

export function moscowDayEnd(value: string): string {
  return new Date(`${value}T23:59:59.999+03:00`).toISOString();
}

function upstreamDate(value: unknown): string {
  const parsed = z.union([z.string(), z.date()]).parse(value);
  const date = new Date(parsed);
  assertValidDate(date);
  return date.toISOString();
}

function assertValidDate(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Telegram вернул некорректную дату");
  }
}
