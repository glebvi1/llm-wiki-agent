import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client";
// eslint-disable-next-line import-x/no-unresolved, n/no-missing-import -- ошибка wildcard types-export SDK
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as z from "zod/v4";

import {
  chatFromUpstream,
  messageFromUpstream,
  type Chat,
  type TelegramMessage,
} from "#src/model.ts";

export interface Draft {
  chatId: string;
  text: string;
  date: string | null;
  replyTo: number | null;
}

export interface TelegramGateway {
  listChats(): Promise<Chat[]>;
  messagesAfter(
    chatId: string,
    afterId: number,
    limit?: number,
  ): Promise<{ messages: TelegramMessage[]; hasMore: boolean }>;
  history(chatId: string, limit?: number): Promise<TelegramMessage[]>;
  messagesBefore(
    chatId: string,
    beforeId: number,
    limit?: number,
  ): Promise<TelegramMessage[]>;
  messagesByIds(
    chatId: string,
    ids: readonly number[],
  ): Promise<{ messages: TelegramMessage[]; missingIds: number[] }>;
  search(
    chatId: string,
    query: string,
    from?: string,
    to?: string,
    limit?: number,
  ): Promise<TelegramMessage[]>;
  context(
    chatId: string,
    messageId: number,
    size?: number,
  ): Promise<TelegramMessage[]>;
  drafts(): Promise<Draft[]>;
  saveDraft(
    chatId: string,
    text: string,
    replyTo: number | null,
  ): Promise<void>;
  send(
    chatId: string,
    text: string,
    replyTo: number | null,
    randomId: number,
  ): Promise<number | null>;
}

export class McpTelegramGateway implements TelegramGateway {
  private connection: Promise<Client> | undefined;
  private readonly usernames = new Map<string, string>();

  constructor(private readonly endpoint: string) {}

  async listChats(): Promise<Chat[]> {
    const output = await this.call("list_chats", { limit: 1000 });
    if (typeof output === "string") {
      assert(
        output.startsWith("No chats"),
        "Telegram MCP list_chats вернул неожиданный ответ",
      );
      return [];
    }
    const rows = z.object({ results: z.array(z.unknown()) }).parse(output);
    const chats = rows.results.map(chatFromUpstream);
    for (const chat of chats) {
      if (chat.username) {
        this.usernames.set(chat.id, chat.username);
      }
    }
    return chats;
  }

  async messagesAfter(chatId: string, afterId: number, limit = 100) {
    const output = await this.call("get_messages_after", {
      chat_id: numericId(chatId),
      after_id: afterId,
      limit,
    });
    const parsed = z
      .object({ messages: z.array(z.unknown()), has_more: z.boolean() })
      .parse(output);
    return {
      messages: parsed.messages.map((row) => this.message(chatId, row)),
      hasMore: parsed.has_more,
    };
  }

  async history(chatId: string, limit = 100): Promise<TelegramMessage[]> {
    const output = await this.call("get_history", {
      chat_id: numericId(chatId),
      limit,
    });
    return this.parseMessages(chatId, output);
  }

  async messagesBefore(
    chatId: string,
    beforeId: number,
    limit = 100,
  ): Promise<TelegramMessage[]> {
    const output = await this.call("get_messages_before", {
      chat_id: numericId(chatId),
      before_id: beforeId,
      limit,
    });
    return this.parseMessages(chatId, output);
  }

  async messagesByIds(chatId: string, ids: readonly number[]) {
    assert(
      ids.length > 0 && ids.length <= 100,
      "за один запрос можно проверить от 1 до 100 сообщений",
    );
    const output = await this.call("get_messages_by_ids", {
      chat_id: numericId(chatId),
      message_ids: [...ids],
    });
    const parsed = z
      .object({
        results: z.array(z.unknown()),
        missing_ids: z.array(z.number().int()),
      })
      .parse(output);
    return {
      messages: parsed.results.map((row) => this.message(chatId, row)),
      missingIds: parsed.missing_ids,
    };
  }

  async search(
    chatId: string,
    query: string,
    from?: string,
    to?: string,
    limit = 100,
  ) {
    const output = await this.call("list_messages", {
      chat_id: numericId(chatId),
      search_query: query,
      limit,
      ...(from ? { from_date: from } : {}),
      ...(to ? { to_date: to } : {}),
    });
    return this.parseMessages(chatId, output);
  }

  async context(chatId: string, messageId: number, size = 3) {
    const output = await this.call("get_message_context", {
      chat_id: numericId(chatId),
      message_id: messageId,
      context_size: size,
    });
    return this.parseMessages(chatId, output);
  }

  async drafts(): Promise<Draft[]> {
    const output = await this.call("get_drafts", {});
    if (typeof output === "string") {
      assert(
        output.startsWith("No drafts"),
        "Telegram MCP get_drafts вернул неожиданный ответ",
      );
      return [];
    }
    const rows = z.object({ drafts: z.array(z.unknown()) }).parse(output);
    return rows.drafts.map((value) => {
      const row = z.record(z.string(), z.unknown()).parse(value);
      const peer = z
        .union([z.string(), z.number()])
        .nullable()
        .parse(row.peer_id);
      return {
        chatId: peer === null ? "" : String(peer),
        text: z.string().optional().parse(row.message) ?? "",
        date: z.string().nullable().parse(row.date),
        replyTo: z
          .number()
          .int()
          .positive()
          .nullable()
          .parse(row.reply_to_msg_id),
      };
    });
  }

  async saveDraft(
    chatId: string,
    text: string,
    replyTo: number | null,
  ): Promise<void> {
    await this.call("save_draft", {
      chat_id: numericId(chatId),
      message: text,
      parse_mode: "plain",
      ...(replyTo === null ? {} : { reply_to_msg_id: replyTo }),
    });
  }

  async send(
    chatId: string,
    text: string,
    replyTo: number | null,
    randomId: number,
  ): Promise<number | null> {
    const output = await this.call("send_message", {
      chat_id: numericId(chatId),
      message: text,
      random_id: randomId,
      ...(replyTo === null ? {} : { reply_to: replyTo }),
    });
    const match = /message_id=(\d+)/.exec(String(output));
    return match?.[1] === undefined ? null : Number(match[1]);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    const client = await connection?.catch(() => undefined);
    await client?.close();
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const client = await this.connect();
    const raw = await client.callTool({ name, arguments: args });
    const response = z
      .object({
        content: z.array(
          z.looseObject({ type: z.string(), text: z.string().optional() }),
        ),
        isError: z.boolean().optional(),
      })
      .parse(raw);
    const text = response.content.find((item) => item.type === "text")?.text;
    assert(typeof text === "string", `Telegram MCP ${name} не вернул текст`);
    if (response.isError) {
      throw new Error(`Telegram MCP ${name}: запрос отклонён`);
    }
    try {
      return JSON.parse(text);
    } catch {
      if (/^(Error|VALIDATION|PRIVACY|FLOOD)/i.test(text)) {
        throw new Error(`Telegram MCP ${name}: операция не выполнена`);
      }
      return text;
    }
  }

  private async connect(): Promise<Client> {
    this.connection ??= (async () => {
      const client = new Client({ name: "telegram-wiki", version: "0.1.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.endpoint)),
      );
      return client;
    })();
    try {
      return await this.connection;
    } catch (error) {
      this.connection = undefined;
      throw error;
    }
  }

  private message(chatId: string, value: unknown): TelegramMessage {
    return messageFromUpstream(chatId, value, this.usernames.get(chatId));
  }

  private parseMessages(chatId: string, output: unknown): TelegramMessage[] {
    if (typeof output === "string") {
      assert(
        output.startsWith("No messages"),
        "Telegram MCP вернул неожиданный текст вместо сообщений",
      );
      return [];
    }
    const rows = z.object({ results: z.array(z.unknown()) }).parse(output);
    return rows.results.map((row) => this.message(chatId, row));
  }
}

function numericId(chatId: string): number {
  const value = Number(chatId);
  assert(Number.isSafeInteger(value), "нужен числовой ID чата");
  return value;
}
