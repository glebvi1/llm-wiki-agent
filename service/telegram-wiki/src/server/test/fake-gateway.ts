import {
  chatSchema,
  messageSchema,
  type Chat,
  type TelegramMessage,
} from "#src/model.ts";
import type { Draft, TelegramGateway } from "#src/server/gateway.ts";

export class FakeTelegramGateway implements TelegramGateway {
  chats: Chat[] = [
    testChat("42", "Личный чат"),
    testChat("-100500", "Канал", "channel"),
  ];
  draftRows: Draft[] = [];
  sendBehavior: "success" | "lost" | "silent" | "failure" = "success";
  sentDate = "2026-11-11T12:00:00.000Z";
  readonly sendCalls: {
    chatId: string;
    text: string;
    replyTo: number | null;
    randomId: number;
  }[] = [];
  readonly beforeCalls: { chatId: string; beforeId: number }[] = [];
  readonly failedChats = new Set<string>();
  private readonly rows = new Map<string, TelegramMessage[]>();
  private nextMessageId = 1000;

  setMessages(chatId: string, messages: TelegramMessage[]): void {
    this.rows.set(chatId, structuredClone(messages));
  }

  listChats(): Promise<Chat[]> {
    return Promise.resolve(structuredClone(this.chats));
  }

  messagesAfter(chatId: string, afterId: number, limit = 100) {
    return Promise.resolve().then(() => {
      const messages = this.read(chatId)
        .filter((message) => message.id > afterId)
        .sort((a, b) => a.id - b.id);
      return {
        messages: messages.slice(0, limit),
        hasMore: messages.length > limit,
      };
    });
  }

  history(chatId: string, limit = 100): Promise<TelegramMessage[]> {
    return Promise.resolve().then(() =>
      this.read(chatId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit),
    );
  }

  messagesBefore(
    chatId: string,
    beforeId: number,
    limit = 100,
  ): Promise<TelegramMessage[]> {
    return Promise.resolve().then(() => {
      this.beforeCalls.push({ chatId, beforeId });
      return this.read(chatId)
        .filter((message) => message.id < beforeId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    });
  }

  messagesByIds(chatId: string, ids: readonly number[]) {
    return Promise.resolve().then(() => {
      const messages = this.read(chatId);
      return {
        messages: ids.flatMap((id) => {
          const message = messages.find((item) => item.id === id);
          return message ? [message] : [];
        }),
        missingIds: ids.filter(
          (id) => !messages.some((message) => message.id === id),
        ),
      };
    });
  }

  async search(
    chatId: string,
    query: string,
    from?: string,
    to?: string,
    limit = 100,
  ): Promise<TelegramMessage[]> {
    const needle = query.toLocaleLowerCase("ru");
    return (await this.history(chatId, 1000))
      .filter(
        (message) =>
          message.text.toLocaleLowerCase("ru").includes(needle) &&
          (!from || message.date.slice(0, 10) >= from) &&
          (!to || message.date.slice(0, 10) <= to),
      )
      .slice(0, limit);
  }

  context(
    chatId: string,
    messageId: number,
    size = 3,
  ): Promise<TelegramMessage[]> {
    return Promise.resolve().then(() => {
      const messages = this.read(chatId).sort((a, b) => a.id - b.id);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) {
        return [];
      }
      return messages.slice(Math.max(0, index - size), index + size + 1);
    });
  }

  drafts(): Promise<Draft[]> {
    return Promise.resolve(structuredClone(this.draftRows));
  }

  saveDraft(
    chatId: string,
    text: string,
    replyTo: number | null,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      this.assertAvailable(chatId);
      this.draftRows = [
        ...this.draftRows.filter((draft) => draft.chatId !== chatId),
        { chatId, text, replyTo, date: this.sentDate },
      ];
    });
  }

  send(
    chatId: string,
    text: string,
    replyTo: number | null,
    randomId: number,
  ): Promise<number | null> {
    return Promise.resolve().then(() => {
      this.assertAvailable(chatId);
      this.sendCalls.push({ chatId, text, replyTo, randomId });
      if (this.sendBehavior === "failure") {
        throw new Error("Telegram не принял сообщение");
      }
      const id = this.nextMessageId;
      this.nextMessageId += 1;
      const messages = this.rows.get(chatId) ?? [];
      messages.push(
        testMessage(id, text, this.sentDate, { chatId, out: true, replyTo }),
      );
      this.rows.set(chatId, messages);
      if (this.sendBehavior === "lost") {
        throw new Error("Ответ потерян");
      }
      return this.sendBehavior === "silent" ? null : id;
    });
  }

  private read(chatId: string): TelegramMessage[] {
    this.assertAvailable(chatId);
    return structuredClone(this.rows.get(chatId) ?? []);
  }

  private assertAvailable(chatId: string): void {
    if (this.failedChats.has(chatId)) {
      throw new Error(`Чат ${chatId} временно недоступен`);
    }
  }
}

export function testChat(
  id: string,
  title: string,
  type: "private" | "group" | "channel" = "private",
): Chat {
  return chatSchema.parse({ id, title, type });
}

export function testMessage(
  id: number,
  text: string,
  date: string,
  override: Partial<TelegramMessage> = {},
): TelegramMessage {
  return messageSchema.parse({
    id,
    chatId: "42",
    sender: "Глеб",
    senderId: "7",
    date,
    text,
    edited: null,
    replyTo: null,
    topic: null,
    out: false,
    media: null,
    link: null,
    ...override,
  });
}
