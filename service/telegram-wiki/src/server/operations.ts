import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import type { SendOperation, TelegramMessage } from "#src/model.ts";
import type { TelegramGateway } from "#src/server/gateway.ts";
import { recordValue } from "#src/server/record.ts";
import type { WikiStore } from "#src/server/store.ts";

export class TelegramOperations {
  constructor(
    private readonly store: WikiStore,
    private readonly gateway: TelegramGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepareSend(chatId: string, text: string, replyTo: number | null) {
    const chat = await this.writableChat(chatId);
    assert(
      text.trim().length > 0 && text.length <= 4096,
      "текст должен содержать от 1 до 4096 символов",
    );
    const approvalId = randomUUID();
    const operationId = randomUUID();
    const createdAt = this.now().toISOString();
    await this.store.update((state) => {
      state.approvals[approvalId] = {
        operationId,
        chatId,
        text,
        replyTo,
        createdAt,
      };
    });
    return {
      approvalId,
      operationId,
      chatId,
      chat,
      text,
      replyTo,
      createdAt,
      next: [
        "Покажите этот вариант пользователю.",
        "Отправка возможна только через send_prepared с теми же",
        "approvalId, operationId, chatId, text и replyTo.",
      ].join(" "),
    };
  }

  async sendPrepared(input: {
    approvalId: string;
    operationId: string;
    chatId: string;
    text: string;
    replyTo: number | null;
  }) {
    const state = await this.store.read();
    const existing = recordValue(state.sends, input.operationId);
    if (existing?.status === "sent") {
      assert(
        existing.approvalId === input.approvalId,
        "operationId уже связан с другим подтверждением",
      );
      assertSame(existing, input);
      return sentResult(existing, false);
    }
    const approval = recordValue(state.approvals, input.approvalId);
    assert(approval, "подтверждение не найдено; подготовьте сообщение заново");
    assertSame(approval, input);
    assert(
      approval.operationId === input.operationId,
      "operationId не относится к этому подтверждению",
    );
    if (existing) {
      assertSame(existing, input);
      if (existing.status === "pending" || existing.status === "uncertain") {
        const recovered = await this.recover(existing);
        if (
          recovered.sent ||
          existing.messageId !== null ||
          existing.detail?.startsWith("Найдено несколько")
        ) {
          return recovered;
        }
        return this.attempt(existing);
      }
      if (existing.status === "failed") {
        return {
          sent: false,
          status: existing.status,
          detail: existing.detail,
        };
      }
    }
    const operation: SendOperation = {
      operationId: input.operationId,
      approvalId: input.approvalId,
      chatId: input.chatId,
      text: input.text,
      replyTo: input.replyTo,
      status: "pending",
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      attemptAt: null,
      messageId: null,
      detail: null,
    };
    return this.attempt(operation);
  }

  async draftConflict(
    chatId: string,
    expectedDraft: string | null,
    replaceExisting: boolean,
  ) {
    await this.writableChat(chatId);
    const drafts = await this.gateway.drafts();
    const current = drafts.find((draft) => draft.chatId === chatId) ?? null;
    const currentText = current?.text ?? null;
    if (currentText !== expectedDraft) {
      return {
        allowed: false as const,
        conflict: true as const,
        current,
        detail:
          "Черновик изменился с момента чтения. Покажите конфликт; ничего не заменено.",
      };
    }
    if (currentText && !replaceExisting) {
      return {
        allowed: false as const,
        conflict: true as const,
        current,
        detail:
          "В чате уже есть черновик. Покажите его пользователю и получите согласие на замену.",
      };
    }
    return { allowed: true as const, conflict: false as const, current };
  }

  private async writableChat(chatId: string) {
    const chats = await this.gateway.listChats();
    const chat = chats.find((item) => item.id === chatId);
    assert(chat, "чат недоступен аккаунту");
    assert(
      chat.type !== "channel",
      "в первой версии каналы доступны только для чтения",
    );
    return chat;
  }

  private async attempt(operation: SendOperation) {
    operation.status = "pending";
    operation.attemptAt = this.now().toISOString();
    operation.detail = null;
    await this.store.update((state) => {
      state.sends[operation.operationId] = structuredClone(operation);
    });
    try {
      const messageId = await this.gateway.send(
        operation.chatId,
        operation.text,
        operation.replyTo,
        telegramRandomId(operation.operationId),
      );
      if (messageId === null) {
        return await this.recover(operation);
      }
      operation.status = "sent";
      operation.messageId = messageId;
      await this.store.update((state) => {
        state.sends[operation.operationId] = structuredClone(operation);
        state.approvals = withoutKey(state.approvals, operation.approvalId);
      });
      return sentResult(operation, false);
    } catch {
      operation.status = "uncertain";
      operation.detail =
        "Ответ Telegram потерян; перед любым повтором проверяется фактическая история";
      await this.store.update((state) => {
        state.sends[operation.operationId] = structuredClone(operation);
      });
      return this.recover(operation);
    }
  }

  private async recover(operation: SendOperation) {
    const messages = await this.gateway.history(operation.chatId, 100);
    const found = matchingSent(messages, operation);
    if (found.length === 1) {
      operation.status = "sent";
      operation.messageId = found[0]?.id ?? null;
      operation.detail = "Отправка подтверждена чтением истории после обрыва";
      await this.store.update((state) => {
        state.sends[operation.operationId] = structuredClone(operation);
        state.approvals = withoutKey(state.approvals, operation.approvalId);
      });
      return sentResult(operation, true);
    }
    operation.status = "uncertain";
    operation.detail =
      found.length > 1
        ? "Найдено несколько одинаковых сообщений; автоматический повтор запрещён"
        : "Сообщение в истории пока не подтверждено; следующий повтор использует тот же Telegram random_id";
    await this.store.update((state) => {
      state.sends[operation.operationId] = structuredClone(operation);
    });
    return {
      sent: false as const,
      status: "uncertain",
      detail: operation.detail,
      operationId: operation.operationId,
    };
  }
}

export function matchingSent(
  messages: TelegramMessage[],
  operation: SendOperation,
): TelegramMessage[] {
  const attempt =
    operation.attemptAt === null ? 0 : Date.parse(operation.attemptAt) - 5000;
  return messages.filter(
    (message) =>
      message.out &&
      message.text === operation.text &&
      message.replyTo === operation.replyTo &&
      Date.parse(message.date) >= attempt,
  );
}

function assertSame(
  expected: { chatId: string; text: string; replyTo: number | null },
  actual: { chatId: string; text: string; replyTo: number | null },
): void {
  assert(
    expected.chatId === actual.chatId &&
      expected.text === actual.text &&
      expected.replyTo === actual.replyTo,
    "operationId или approvalId уже связан с другим адресатом, темой или текстом",
  );
}

function withoutKey<T>(
  values: Record<string, T>,
  key: string,
): Record<string, T> {
  const { [key]: _removed, ...remaining } = values;
  return remaining;
}

function telegramRandomId(operationId: string): number {
  const digest = createHash("sha256")
    .update(`telegram-wiki:${operationId}`)
    .digest();
  return Math.max(1, Number(digest.readBigUInt64BE(0) & 0x001fffffffffffffn));
}

function sentResult(operation: SendOperation, recovered: boolean) {
  return {
    sent: true as const,
    status: "sent",
    operationId: operation.operationId,
    messageId: operation.messageId,
    recovered,
    link:
      operation.chatId.startsWith("-100") && operation.messageId
        ? `https://t.me/c/${operation.chatId.slice(4)}/${String(operation.messageId)}`
        : null,
  };
}
