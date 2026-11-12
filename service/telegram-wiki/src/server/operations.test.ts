import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";

import { TelegramOperations } from "#src/server/operations.ts";
import { WikiStore } from "#src/server/store.ts";
import {
  FakeTelegramGateway,
  testChat,
} from "#src/server/test/fake-gateway.ts";

let root: string;
let store: WikiStore;
let gateway: FakeTelegramGateway;
let operations: TelegramOperations;

describe("операции Telegram", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-send-"));
    store = new WikiStore(root);
    gateway = new FakeTelegramGateway();
    operations = new TelegramOperations(
      store,
      gateway,
      () => new Date("2026-11-11T11:59:00.000Z"),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("черновики", () => {
    it("не затирает существующий или изменившийся черновик", async () => {
      gateway.draftRows = [
        { chatId: "42", text: "Старый", date: null, replyTo: null },
      ];
      await expect(
        operations.draftConflict("42", null, false),
      ).resolves.toMatchObject({
        allowed: false,
        conflict: true,
      });
      await expect(
        operations.draftConflict("42", "Другой", true),
      ).resolves.toMatchObject({
        allowed: false,
        conflict: true,
      });
      await expect(
        operations.draftConflict("42", "Старый", true),
      ).resolves.toMatchObject({
        allowed: true,
        conflict: false,
      });
      expect(gateway.draftRows[0]?.text).toBe("Старый");
    });

    it("запрещает черновики и отправку в каналы", async () => {
      await expect(
        operations.draftConflict("-100500", null, false),
      ).rejects.toThrow("только для чтения");
      await expect(
        operations.prepareSend("-100500", "Текст", null),
      ).rejects.toThrow("только для чтения");
    });
  });

  describe("двухшаговая отправка", () => {
    it("подготавливает один вариант одним чтением чатов и отправляет его", async () => {
      const originalList = gateway.listChats.bind(gateway);
      let listings = 0;
      gateway.listChats = async () => {
        listings += 1;
        return originalList();
      };
      const prepared = await operations.prepareSend(
        "42",
        "Согласованный текст",
        null,
      );
      expect(listings).toBe(1);
      expect(gateway.sendCalls).toHaveLength(0);
      const result = await operations.sendPrepared(prepared);
      expect(result).toMatchObject({
        sent: true,
        status: "sent",
        messageId: 1000,
      });
      expect(gateway.sendCalls).toHaveLength(1);
    });

    it("повтор после успеха возвращает sent даже после удаления approval", async () => {
      const prepared = await operations.prepareSend("42", "Один раз", null);
      const first = await operations.sendPrepared(prepared);
      const second = await operations.sendPrepared(prepared);
      expect(first).toMatchObject({ sent: true, messageId: 1000 });
      expect(second).toMatchObject({ sent: true, messageId: 1000 });
      expect(gateway.sendCalls).toHaveLength(1);
    });

    it("после обрыва сначала находит сообщение и не отправляет дубль", async () => {
      const prepared = await operations.prepareSend("42", "После обрыва", null);
      gateway.sendBehavior = "lost";
      const first = await operations.sendPrepared(prepared);
      expect(first).toMatchObject({
        sent: true,
        recovered: true,
        messageId: 1000,
      });
      gateway.sendBehavior = "success";
      const second = await operations.sendPrepared(prepared);
      expect(second).toMatchObject({ sent: true, messageId: 1000 });
      expect(gateway.sendCalls).toHaveLength(1);
    });

    it("повторяет тот же random_id, если Telegram и история временно недоступны", async () => {
      const prepared = await operations.prepareSend(
        "42",
        "Тот же random_id",
        null,
      );
      gateway.sendBehavior = "failure";
      const first = await operations.sendPrepared(prepared);
      expect(first).toMatchObject({ sent: false, status: "uncertain" });
      gateway.sendBehavior = "success";
      const second = await operations.sendPrepared(prepared);
      expect(second).toMatchObject({ sent: true });
      expect(gateway.sendCalls).toHaveLength(2);
      assert(gateway.sendCalls[0] && gateway.sendCalls[1]);
      expect(gateway.sendCalls[0].randomId).toBe(gateway.sendCalls[1].randomId);
      expect(gateway.sendCalls[0].randomId).toBeGreaterThan(0);
    });

    it("отклоняет изменение текста или другого approval для operationId", async () => {
      const prepared = await operations.prepareSend("42", "Точный текст", null);
      await expect(
        operations.sendPrepared({ ...prepared, text: "Изменённый" }),
      ).rejects.toThrow("другим адресатом");
      await operations.sendPrepared(prepared);
      const other = await operations.prepareSend("42", "Точный текст", null);
      await expect(
        operations.sendPrepared({ ...prepared, approvalId: other.approvalId }),
      ).rejects.toThrow("другим подтверждением");
      expect(gateway.sendCalls).toHaveLength(1);
    });

    it("не путает чужое сообщение с таким же старым текстом", async () => {
      gateway.chats = [testChat("42", "Личный чат")];
      const prepared = await operations.prepareSend(
        "42",
        "Повторяющаяся фраза",
        null,
      );
      const { testMessage } = await import("#src/server/test/fake-gateway.ts");
      gateway.setMessages("42", [
        testMessage(9, "Повторяющаяся фраза", "2026-11-11T11:00:00.000Z", {
          out: true,
        }),
      ]);
      gateway.sendBehavior = "failure";
      const result = await operations.sendPrepared(prepared);
      expect(result).toMatchObject({ sent: false, status: "uncertain" });
      expect(gateway.sendCalls).toHaveLength(1);
    });
  });
});
