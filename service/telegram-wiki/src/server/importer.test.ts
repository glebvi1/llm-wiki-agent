import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  assert,
  vi,
} from "vitest";
import * as z from "zod/v4";

import { TelegramImporter } from "#src/server/importer.ts";
import { recordValue } from "#src/server/record.ts";
import { WikiStore } from "#src/server/store.ts";
import {
  FakeTelegramGateway,
  testChat,
  testMessage,
} from "#src/server/test/fake-gateway.ts";

let root: string;
let store: WikiStore;
let gateway: FakeTelegramGateway;
let importer: TelegramImporter;

describe("импорт Telegram", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-import-"));
    store = new WikiStore(root);
    gateway = new FakeTelegramGateway();
    importer = new TelegramImporter(
      store,
      gateway,
      () => new Date("2026-11-11T12:00:00.000Z"),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("глубина и продолжение импорта", () => {
    it("now не забирает старую историю, date использует полночь по Москве", async () => {
      gateway.setMessages("42", [
        testMessage(1, "до границы", "2026-11-09T20:59:59.999Z"),
        testMessage(2, "на границе", "2026-11-09T21:00:00.000Z"),
      ]);
      await importer.configure(testChat("42", "Личный чат"), true, "now", null);
      await importer.syncChat("42");
      let state = await store.read();
      const initialChat = recordValue(state.chats, "42");
      assert(initialChat);
      assert(initialChat.newestId === 2);
      assert(Object.keys(initialChat.known).length === 0);
      await expect(sourceBatches(root)).resolves.toHaveLength(0);

      await importer.configure(
        testChat("42", "Личный чат"),
        true,
        "date",
        "2026-11-10",
      );
      await importer.syncChat("42");
      state = await store.read();
      const datedChat = recordValue(state.chats, "42");
      expect(Object.keys(datedChat?.known ?? {})).toStrictEqual(["2"]);
      const batches = await sourceBatches(root);
      expect(
        batches.flatMap((batch) =>
          batch.events.map((event) => event.messageId),
        ),
      ).toStrictEqual([2]);
    });

    it("all догружает более ранние страницы без дублей при повторе", async () => {
      const messages = Array.from({ length: 150 }, (_, index) =>
        testMessage(
          index + 1,
          `Сообщение ${String(index + 1)}`,
          "2026-11-01T12:00:00.000Z",
        ),
      );
      gateway.setMessages("42", messages);
      await importer.configure(testChat("42", "Личный чат"), true, "all", null);
      await importer.syncChat("42");
      expect(gateway.beforeCalls).toStrictEqual([
        { chatId: "42", beforeId: 51 },
      ]);
      expect(
        (await sourceBatches(root)).flatMap((batch) => batch.events),
      ).toHaveLength(150);
      expect(
        recordValue((await store.read()).chats, "42")?.backfillComplete,
      ).toBe(true);

      await importer.syncChat("42");
      expect(
        (await sourceBatches(root)).flatMap((batch) => batch.events),
      ).toHaveLength(150);
    });

    it("переименование сохраняет настройки и прогресс", async () => {
      await importer.configure(
        testChat("42", "Старое имя"),
        true,
        "date",
        "2026-11-01",
        "Общие дела",
      );
      gateway.setMessages("42", [
        testMessage(1, "Исходник", "2026-11-02T12:00:00.000Z"),
      ]);
      await importer.syncChat("42");
      gateway.chats = [testChat("42", "Новое имя")];
      await importer.refreshChats();
      const chat = recordValue((await store.read()).chats, "42");
      expect(chat).toMatchObject({
        title: "Новое имя",
        enabled: true,
        importFrom: "date",
        fromDate: "2026-11-01",
        newestId: 1,
        comment: "Общие дела",
      });
    });

    it("при получении сообщений сохраняет свежий комментарий и учитывает отключение", async () => {
      const chat = testChat("42", "Личный чат");
      const messages = [
        testMessage(1, "Комментарий: подмена", "2026-11-01T12:00:00.000Z"),
      ];
      gateway.setMessages(chat.id, messages);
      await importer.configure(chat, true, "all", null, "Старый комментарий");
      const history = vi.spyOn(gateway, "history");
      history.mockImplementationOnce(async () => {
        await importer.configure(chat, false, "all", null);
        return messages;
      });
      await importer.syncChat(chat.id);
      expect((await store.read()).chats[chat.id]).toMatchObject({
        enabled: false,
        comment: "Старый комментарий",
      });
      await expect(sourceBatches(root)).resolves.toHaveLength(0);

      await importer.configure(chat, true, "all", null);
      history.mockImplementationOnce(async () => {
        await importer.configure(chat, true, "all", null, "Новый комментарий");
        return messages;
      });
      await importer.syncChat(chat.id);
      await importer.syncChat(chat.id);
      expect((await new WikiStore(root).read()).chats[chat.id]).toMatchObject({
        enabled: true,
        comment: "Новый комментарий",
        newestId: 1,
      });
      await expect(sourceBatches(root)).resolves.toHaveLength(1);
    });

    it("сбой одного чата не останавливает остальные и не создаёт дубли", async () => {
      gateway.chats = [testChat("42", "Первый"), testChat("43", "Второй")];
      gateway.setMessages("42", [
        testMessage(1, "Первый", "2026-11-01T12:00:00.000Z"),
      ]);
      gateway.setMessages("43", [
        testMessage(1, "Второй", "2026-11-01T12:00:00.000Z", { chatId: "43" }),
      ]);
      await importer.configure(
        gateway.chats[0] ?? testChat("42", "Первый"),
        true,
        "all",
        null,
      );
      await importer.configure(
        gateway.chats[1] ?? testChat("43", "Второй"),
        true,
        "all",
        null,
      );
      gateway.failedChats.add("42");
      await importer.syncAll();
      let state = await store.read();
      expect(recordValue(state.chats, "42")?.lastError).not.toBeNull();
      const otherChat = recordValue(state.chats, "43");
      expect(Object.keys(otherChat?.known ?? {})).toStrictEqual(["1"]);

      gateway.failedChats.delete("42");
      await importer.syncAll();
      state = await store.read();
      expect(recordValue(state.chats, "42")?.lastError).toBeNull();
      expect(
        (await sourceBatches(root)).flatMap((batch) => batch.events),
      ).toHaveLength(2);
    });
  });

  describe("восстановление и изменения Telegram", () => {
    it("достраивает источник из pending после обрыва", async () => {
      await importer.configure(testChat("42", "Личный чат"), true, "now", null);
      const chat = recordValue((await store.read()).chats, "42");
      assert(chat);
      const folder = join(
        root,
        "Исходники",
        "Telegram",
        "Личный чат — chat-42",
        "2026-11-11",
      );
      const pending = {
        chat,
        jsonPath: join(folder, "recovered.json"),
        markdownPath: join(folder, "recovered.md"),
        jsonText: `${JSON.stringify(
          {
            schemaVersion: 1,
            receivedAt: "2026-11-11T11:00:00.000Z",
            events: [],
          },
          null,
          2,
        )}\n`,
        markdownText: "# Восстановленная порция\n",
      };
      const pendingPath = join(
        root,
        ".local",
        "telegram-wiki",
        "pending",
        "42.json",
      );
      await mkdir(dirname(pendingPath), { recursive: true });
      await writeFile(pendingPath, JSON.stringify(pending), "utf8");
      await importer.syncChat("42");
      await expect(readFile(pending.jsonPath, "utf8")).resolves.toBe(
        pending.jsonText,
      );
      await expect(readFile(pending.markdownPath, "utf8")).resolves.toBe(
        pending.markdownText,
      );
      await expect(readFile(pendingPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("сохраняет правку и удаление новыми неизменяемыми событиями", async () => {
      gateway.setMessages("42", [
        testMessage(1, "Черновик решения", "2026-11-01T12:00:00.000Z"),
        testMessage(2, "Удалят", "2026-11-01T12:01:00.000Z"),
      ]);
      await importer.configure(testChat("42", "Личный чат"), true, "all", null);
      await importer.syncChat("42");
      gateway.setMessages("42", [
        testMessage(1, "Подтверждённое решение", "2026-11-01T12:00:00.000Z", {
          edited: "2026-11-11T10:00:00.000Z",
        }),
      ]);
      await importer.syncChat("42");
      const events = (await sourceBatches(root)).flatMap(
        (batch) => batch.events,
      );
      expect(
        events
          .filter((event) => event.kind === "edited")
          .map((event) => event.messageId),
      ).toStrictEqual([1]);
      expect(
        events
          .filter((event) => event.kind === "deleted")
          .map((event) => event.messageId),
      ).toStrictEqual([2]);
      expect(events).toHaveLength(4);
    });

    it("удаление источников также отменяет pending восстановления", async () => {
      await importer.configure(testChat("42", "Личный чат"), true, "now", null);
      const pendingPath = join(
        root,
        ".local",
        "telegram-wiki",
        "pending",
        "42.json",
      );
      await mkdir(dirname(pendingPath), { recursive: true });
      await writeFile(pendingPath, "{}", "utf8");
      await importer.deleteSources("42");
      expect((await store.read()).chats["42"]).toBeUndefined();
      await expect(readFile(pendingPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});

async function sourceBatches(wikiRoot: string) {
  const paths = (
    await filesUnder(join(wikiRoot, "Исходники", "Telegram"))
  ).filter((path) => path.endsWith(".json"));
  const schema = z.object({
    events: z.array(
      z.object({
        kind: z.enum(["created", "edited", "deleted"]),
        messageId: z.number(),
      }),
    ),
  });
  return Promise.all(
    paths.map(async (path) =>
      schema.parse(JSON.parse(await readFile(path, "utf8"))),
    ),
  );
}

async function filesUnder(rootPath: string): Promise<string[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(rootPath, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
