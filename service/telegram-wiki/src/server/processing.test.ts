import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TelegramImporter } from "#src/server/importer.ts";
import { WikiProcessing } from "#src/server/processing.ts";
import { WikiStore } from "#src/server/store.ts";
import {
  FakeTelegramGateway,
  testChat,
} from "#src/server/test/fake-gateway.ts";

let root: string;
let store: WikiStore;
let processing: WikiProcessing;

describe("обработка Wiki", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-processing-"));
    store = new WikiStore(root);
    processing = new WikiProcessing(store);
    await writeWikiFile(
      ".agents/skills/wiki-telegram-ingest/SKILL.md",
      "# Обработка Telegram\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("принятие и завершение обработки", () => {
    it("не начинает проход до принятия точной версии скилла", async () => {
      await writeSource("batch.json");
      expect((await processing.status()).enabled).toBe(false);
      await expect(processing.begin(1)).rejects.toThrow("ещё не принята");
    });

    it("восстанавливает activeRun и идемпотентно завершает проверенный проход", async () => {
      await writeSource("batch.json");
      const importer = new TelegramImporter(store, new FakeTelegramGateway());
      const chat = testChat("42", "Актуальное название", "group");
      await importer.configure(
        chat,
        true,
        "all",
        null,
        "Комментарий перед проходом",
      );
      const initial = await processing.status();
      await writeWikiFile(
        ".agents/skills/wiki-telegram-ingest/approval.json",
        `${JSON.stringify({ status: "approved", approvedBundleSha256: initial.bundleSha256 })}\n`,
      );
      await writeWikiFile("Журнал/Telegram/evidence.md", "Основание итога\n");
      await writeWikiFile("Журнал/Telegram/question.md", "Открытый вопрос\n");
      await writeWikiFile("Журнал/Telegram/summary.md", "Итог прохода\n");
      await writeWikiFile("wiki/Проект.md", "Подтверждённое решение\n");

      const runs = await Promise.all([
        processing.begin(1),
        processing.begin(20),
      ]);
      const run = runs[0];
      expect(runs[1].runId).toBe(run.runId);
      expect(runs.filter((entry) => "recovered" in entry)).toHaveLength(1);
      expect(run.chatSettings).toStrictEqual({
        "42": {
          id: "42",
          title: "Актуальное название",
          type: "group",
          comment: "Комментарий перед проходом",
        },
      });
      await importer.configure(
        chat,
        false,
        "all",
        null,
        "Исправленный комментарий",
      );
      expect((await processing.begin(1)).chatSettings).toStrictEqual(
        run.chatSettings,
      );
      const sourcePath =
        "Исходники/Telegram/Чат — chat-42/2026-11-11/batch.json";
      const result = {
        runId: run.runId,
        outcomes: [
          {
            path: sourcePath,
            sha256: await fileHash(sourcePath),
            result: "waiting",
            evidencePath: "Журнал/Telegram/evidence.md",
          },
        ],
        files: [
          { path: "wiki/Проект.md", sha256: await fileHash("wiki/Проект.md") },
        ],
        pendingQuestions: [
          {
            id: "question-1",
            path: "Журнал/Telegram/question.md",
            taskId: "task-1",
          },
        ],
        resolvedQuestions: [],
        summaryPath: "Журнал/Telegram/summary.md",
      };
      await expect(processing.finish(result)).resolves.toStrictEqual({
        completed: run.runId,
        recovered: false,
      });
      await expect(processing.finish(result)).resolves.toStrictEqual({
        completed: run.runId,
        recovered: true,
      });
      const state = await store.read();
      expect(state.activeRun).toBeNull();
      expect(state.processedBatches[sourcePath]).toBe(
        await fileHash(sourcePath),
      );
      expect(state.pendingQuestions).toStrictEqual(result.pendingQuestions);
      expect(state.runChatSettings[run.runId]).toStrictEqual(run.chatSettings);
      expect((await processing.status()).batches).toHaveLength(0);
      await writeSource("queued.json");
      expect((await processing.begin(1)).chatSettings?.["42"]?.comment).toBe(
        "Исправленный комментарий",
      );
    });

    it("отклоняет чужой runId, изменённый источник и выход за пределы Wiki", async () => {
      await writeSource("batch.json");
      const initial = await processing.status();
      await writeWikiFile(
        ".agents/skills/wiki-telegram-ingest/approval.json",
        `${JSON.stringify({ status: "approved", approvedBundleSha256: initial.bundleSha256 })}\n`,
      );
      const run = await processing.begin(1);
      expect(run.chatSettings).toStrictEqual({
        "42": {
          id: "42",
          title: "Старое название",
          type: "private",
          comment: "",
        },
      });
      const sourcePath =
        "Исходники/Telegram/Чат — chat-42/2026-11-11/batch.json";
      const result = {
        runId: randomUUID(),
        outcomes: [
          {
            path: sourcePath,
            sha256: await fileHash(sourcePath),
            result: "applied",
            evidencePath: "Журнал/Telegram/evidence.md",
          },
        ],
        files: [],
        pendingQuestions: [],
        resolvedQuestions: [],
        summaryPath: "Журнал/Telegram/summary.md",
      };
      await expect(processing.finish(result)).rejects.toThrow(
        "другому проходу",
      );
      await writeWikiFile("Журнал/Telegram/evidence.md", "Основание\n");
      await writeWikiFile("Журнал/Telegram/summary.md", "Итог\n");
      await expect(
        processing.finish({
          ...result,
          runId: run.runId,
          summaryPath: "../outside.md",
        }),
      ).rejects.toThrow("за пределы Wiki");
      await writeSource("batch.json", "изменено");
      await expect(
        processing.finish({ ...result, runId: run.runId }),
      ).rejects.toThrow("исходник изменился");
    });
  });
});

async function writeSource(name: string, text = "решение"): Promise<void> {
  await writeWikiFile(
    `Исходники/Telegram/Чат — chat-42/2026-11-11/${name}`,
    `${JSON.stringify({
      schemaVersion: 1,
      chat: testChat("42", "Старое название"),
      events: [{ kind: "created", text }],
    })}\n`,
  );
}

async function writeWikiFile(path: string, text: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(root, path)))
    .digest("hex");
}
