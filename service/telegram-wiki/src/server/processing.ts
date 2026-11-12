import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import * as z from "zod/v4";

import { chatSchema, type WikiState } from "#src/model.ts";
import { recordValue } from "#src/server/record.ts";
import { isMissing, type WikiStore } from "#src/server/store.ts";

const outcomeSchema = z.object({
  runId: z.uuid(),
  outcomes: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().length(64),
      result: z.enum(["applied", "no_change", "waiting", "mixed"]),
      evidencePath: z.string(),
    }),
  ),
  files: z.array(z.object({ path: z.string(), sha256: z.string().length(64) })),
  pendingQuestions: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      taskId: z.string().nullable(),
    }),
  ),
  resolvedQuestions: z.array(
    z.object({ id: z.string(), evidencePath: z.string() }),
  ),
  summaryPath: z.string(),
});

export class WikiProcessing {
  constructor(private readonly store: WikiStore) {}

  async status() {
    const state = await this.store.read();
    const bundleSha256 = await this.bundleHash();
    const approval = await this.approval();
    const batches = (await this.sourceBatches()).filter((batch) => {
      const processed = recordValue(state.processedBatches, batch.path);
      return processed === undefined;
    });
    return {
      enabled:
        approval.status === "approved" &&
        approval.approvedBundleSha256 === bundleSha256,
      bundleSha256,
      batches,
      activeRun: state.activeRun,
      pendingQuestions: state.pendingQuestions,
      processedCount: Object.keys(state.processedBatches).length,
    };
  }

  async begin(maxBatches: number) {
    assert(
      Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 20,
      "maxBatches: от 1 до 20",
    );
    const status = await this.status();
    assert(status.enabled, "эта версия скилла ещё не принята Глебом");
    const runId = randomUUID();
    const { activeRun } = await this.store.update((state) => {
      if (state.activeRun) {
        state.activeRun.chatSettings ??= snapshotChatSettings(
          state,
          state.activeRun.batches,
          status.batches,
        );
        return;
      }
      const batches = status.batches
        .filter(
          ({ path }) => recordValue(state.processedBatches, path) === undefined,
        )
        .slice(0, maxBatches)
        .map(({ path, sha256 }) => ({ path, sha256 }));
      state.activeRun = {
        runId,
        batches,
        startedAt: new Date().toISOString(),
        chatSettings: snapshotChatSettings(state, batches, status.batches),
      };
    });
    assert(activeRun, "не удалось сохранить проход");
    return activeRun.runId === runId
      ? activeRun
      : { ...activeRun, recovered: true };
  }

  async finish(input: unknown) {
    const result = outcomeSchema.parse(input);
    const resultHash = hash(JSON.stringify(result));
    const initial = await this.store.read();
    const completed = recordValue(initial.completedRuns, result.runId);
    if (completed !== undefined) {
      assert(completed === resultHash, "повтор finish содержит другой итог");
      return { completed: result.runId, recovered: true };
    }
    const run = initial.activeRun;
    assert(run?.runId === result.runId, "итог относится к другому проходу");
    assert(
      result.outcomes.length === run.batches.length,
      "не все порции получили итог",
    );
    for (const [index, batch] of run.batches.entries()) {
      const outcome = result.outcomes.at(index);
      assert(
        outcome?.path === batch.path && outcome.sha256 === batch.sha256,
        "итог не совпадает с исходниками прохода",
      );
      assert(
        (await this.fileHash(batch.path)) === batch.sha256,
        "исходник изменился во время прохода",
      );
      assert(
        await this.exists(outcome.evidencePath),
        "не сохранено основание итога",
      );
    }
    for (const file of result.files) {
      assert(
        (await this.fileHash(file.path)) === file.sha256,
        `сохранённый файл не совпадает с итогом: ${file.path}`,
      );
    }
    for (const question of result.pendingQuestions) {
      assert(
        await this.exists(question.path),
        `потеряны материалы вопроса ${question.id}`,
      );
    }
    for (const question of result.resolvedQuestions) {
      assert(
        await this.exists(question.evidencePath),
        `не сохранено решение вопроса ${question.id}`,
      );
    }
    assert(await this.exists(result.summaryPath), "не сохранён итог прохода");
    const finish = { recovered: false };
    await this.store.update((state) => {
      const completedHash = recordValue(state.completedRuns, run.runId);
      if (completedHash !== undefined) {
        assert(
          completedHash === resultHash,
          "повтор finish содержит другой итог",
        );
        finish.recovered = true;
        return;
      }
      const active = state.activeRun;
      assert(active?.runId === run.runId, "итог относится к другому проходу");
      for (const batch of active.batches) {
        state.processedBatches[batch.path] = batch.sha256;
        const chatId = /chat-(-?\d+)\//.exec(batch.path)?.[1];
        const chat = chatId === undefined ? undefined : state.chats[chatId];
        if (chat) {
          chat.lastProcessAt = new Date().toISOString();
        }
      }
      state.pendingQuestions = result.pendingQuestions;
      state.completedRuns[run.runId] = resultHash;
      state.runChatSettings[run.runId] = active.chatSettings ?? {};
      state.activeRun = null;
    });
    return { completed: run.runId, recovered: finish.recovered };
  }

  private async sourceBatches() {
    const root = join(this.store.wikiRoot, "Исходники", "Telegram");
    const paths = (await filesUnder(root)).filter((path) =>
      path.endsWith(".json"),
    );
    const batches = await Promise.all(
      paths.map(async (path) => {
        const text = await readFile(path, "utf8");
        const parsed = z
          .object({
            schemaVersion: z.literal(1),
            chat: chatSchema.optional(),
            events: z.array(z.unknown()),
          })
          .safeParse(JSON.parse(text));
        assert(parsed.success, `повреждён исходник ${path}`);
        return {
          path: relative(this.store.wikiRoot, path).replaceAll("\\", "/"),
          sha256: hash(text),
          events: parsed.data.events.length,
          chat: parsed.data.chat,
        };
      }),
    );
    return batches.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async bundleHash(): Promise<string> {
    const folder = join(
      this.store.wikiRoot,
      ".agents",
      "skills",
      "wiki-telegram-ingest",
    );
    const paths = (await filesUnder(folder)).filter(
      (path) =>
        !path.includes("__pycache__") && !path.endsWith("approval.json"),
    );
    const digest = createHash("sha256");
    for (const path of paths.sort()) {
      digest.update(relative(folder, path).replaceAll("\\", "/"));
      digest.update("\0");
      digest.update(await readFile(path));
      digest.update("\0");
    }
    return digest.digest("hex");
  }

  private async approval(): Promise<{
    status: string | null;
    approvedBundleSha256: string | null;
  }> {
    try {
      const text = await readFile(
        join(
          this.store.wikiRoot,
          ".agents",
          "skills",
          "wiki-telegram-ingest",
          "approval.json",
        ),
        "utf8",
      );
      return z
        .object({
          status: z.string().nullable().default(null),
          approvedBundleSha256: z.string().nullable().default(null),
        })
        .parse(JSON.parse(text));
    } catch (error) {
      if (isMissing(error)) {
        return { status: null, approvedBundleSha256: null };
      }
      throw error;
    }
  }

  private async fileHash(path: string): Promise<string> {
    return hash(await readFile(this.safePath(path)));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(this.safePath(path));
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  private safePath(path: string): string {
    const root = resolve(this.store.wikiRoot);
    const resolved = resolve(root, path);
    const rel = relative(root, resolved);
    const outside =
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("..\\") ||
      isAbsolute(rel);
    assert(rel !== "" && !outside, "путь выходит за пределы Wiki");
    return resolved;
  }
}

function snapshotChatSettings(
  state: WikiState,
  selected: { path: string }[],
  sources: { path: string; chat?: z.infer<typeof chatSchema> | undefined }[],
): NonNullable<NonNullable<WikiState["activeRun"]>["chatSettings"]> {
  const snapshot: NonNullable<
    NonNullable<WikiState["activeRun"]>["chatSettings"]
  > = {};
  const chatByPath = new Map(sources.map(({ path, chat }) => [path, chat]));
  for (const { path } of selected) {
    const original = chatByPath.get(path);
    const id = original?.id ?? /chat-(-?\d+)\//.exec(path)?.[1];
    const settings = id === undefined ? undefined : state.chats[id];
    const chat = settings ?? original;
    if (chat) {
      snapshot[chat.id] = {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        comment: settings?.comment ?? "",
      };
    }
  }
  return snapshot;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function filesUnder(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}
