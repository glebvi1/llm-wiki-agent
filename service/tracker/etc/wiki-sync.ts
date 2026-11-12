import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { moscowDay, weekStart } from "#src/domain/time.ts";

const sequence = v.pipe(v.string(), v.regex(/^(0|[1-9]\d*)$/u));
const instant = v.pipe(v.string(), v.isoTimestamp());
const configSchema = v.object({
  baseUrl: v.pipe(v.string(), v.url()),
  token: v.pipe(v.string(), v.minLength(32)),
  wikiRoot: v.string(),
});
const pageSchema = v.looseObject({
  schemaVersion: v.literal(1),
  historyStartedAt: v.nullable(instant),
  capturedAt: instant,
  until: sequence,
  cursor: sequence,
  complete: v.boolean(),
  changes: v.array(
    v.looseObject({
      sequence,
      entityType: v.string(),
      entityId: v.string(),
      operation: v.string(),
      recordedAt: instant,
      payload: v.unknown(),
    }),
  ),
  snapshot: v.optional(v.unknown()),
});
const responseSchema = v.object({ ok: v.literal(true), result: pageSchema });
const statusSchema = v.object({
  schemaVersion: v.literal(1),
  cursor: sequence,
  lastSuccessAt: instant,
  completeThrough: instant,
  historyStartedAt: v.nullable(instant),
  lastBatch: v.nullable(v.string()),
});
const pendingSchema = v.object({
  archive: v.nullable(v.object({ relativePath: v.string(), text: v.string() })),
  status: statusSchema,
});

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function main(): Promise<void> {
  try {
    // eslint-disable-next-line n/no-process-env -- путь к секрету задаётся окружением пользователя Windows
    const appData = process.env.APPDATA;
    assert(appData, "APPDATA не задан");
    const path =
      process.argv[2] ?? join(appData, "Gyromind", "tracker-wiki.json");
    const config = v.parse(
      configSchema,
      JSON.parse(await readFile(path, "utf8")),
    );
    const status = await sync(config);
    console.log(
      `трекер получен: ${status.completeThrough}, курсор ${status.cursor}`,
    );
  } catch {
    // Тело ответа и исключения стороннего HTTP-клиента могут содержать секреты.
    console.error(
      "не удалось получить трекер; предыдущая завершённая выгрузка сохранена",
    );
    process.exitCode = 1;
  }
}

async function sync(config: v.InferOutput<typeof configSchema>) {
  const origin = new URL(config.baseUrl);
  assert(
    origin.protocol === "https:" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "localhost",
  );
  assert(
    !origin.username && !origin.password && !origin.search && !origin.hash,
  );
  const local = join(config.wikiRoot, ".local", "tracker-sync");
  const sources = join(config.wikiRoot, "Исходники", "Трекер");
  await mkdir(local, { recursive: true });
  await mkdir(sources, { recursive: true });
  const lockPath = join(local, "sync.lock");
  await acquireLock(lockPath);
  try {
    await recover(local, sources);
    const previousText = await optionalFile(join(local, "status.json"));
    const previous =
      previousText === null
        ? null
        : v.parse(statusSchema, JSON.parse(previousText));
    const after = previous?.cursor ?? "0";
    let cursor = after;
    let first: v.InferOutput<typeof pageSchema> | undefined;
    const pages: v.InferOutput<typeof pageSchema>[] = [];
    for (;;) {
      const url = new URL("/api/wiki/export", origin);
      url.searchParams.set("after", cursor);
      url.searchParams.set("limit", "500");
      if (first) {
        url.searchParams.set("until", first.until);
        url.searchParams.set("capturedAt", first.capturedAt);
      }
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      assert(response.ok, `ошибка HTTP ${String(response.status)}`);
      const { result: page } = v.parse(responseSchema, await response.json());
      if (!first) {
        first = page;
        assert(
          BigInt(page.until) >= BigInt(after),
          "сервер потерял историю; курсор уменьшился",
        );
        if (!previous) {
          assert("snapshot" in page, "первичная выгрузка без полного снимка");
        }
      } else {
        assert(page.until === first.until, "граница выгрузки изменилась");
        assert(page.capturedAt === first.capturedAt, "время среза изменилось");
        assert(
          page.historyStartedAt === first.historyStartedAt,
          "граница истории изменилась",
        );
      }
      let last = BigInt(cursor);
      for (const change of page.changes) {
        const next = BigInt(change.sequence);
        assert(
          next > last && next <= BigInt(page.until),
          "нарушен порядок истории",
        );
        last = next;
      }
      assert(
        BigInt(page.cursor) >= last &&
          BigInt(page.cursor) <= BigInt(page.until),
      );
      if (page.complete) {
        assert(
          page.cursor === page.until,
          "неполный курсор завершённой выгрузки",
        );
      } else {
        assert(
          BigInt(page.cursor) === last && last > BigInt(cursor),
          "страница не продвинула курсор",
        );
      }
      pages.push(page);
      cursor = page.cursor;
      if (page.complete) {
        break;
      }
    }
    const receivedAt = new Date().toISOString();
    const changed = previous === null || cursor !== after;
    const week = weekStart(moscowDay(new Date(first.capturedAt)));
    const relativePath = `${week}/${after}-${cursor}.json`;
    const status = {
      schemaVersion: 1,
      cursor,
      lastSuccessAt: receivedAt,
      completeThrough: first.capturedAt,
      historyStartedAt: first.historyStartedAt,
      lastBatch: changed ? relativePath : previous.lastBatch,
    } as const;
    const pending = {
      archive: changed
        ? {
            relativePath,
            text: json({
              schemaVersion: 1,
              receivedAt,
              after,
              until: cursor,
              pages,
            }),
          }
        : null,
      status,
    };
    await atomicFile(join(local, "pending.json"), json(pending));
    await recover(local, sources);
    return status;
  } finally {
    await unlink(lockPath);
  }
}

async function recover(local: string, sources: string) {
  const pendingText = await optionalFile(join(local, "pending.json"));
  if (pendingText === null) {
    return;
  }
  const pending = v.parse(pendingSchema, JSON.parse(pendingText));
  if (pending.archive) {
    const { relativePath, text } = pending.archive;
    assert(/^\d{4}-\d{2}-\d{2}\/\d+-\d+\.json$/u.test(relativePath));
    const archivePath = join(sources, relativePath);
    await mkdir(dirname(archivePath), { recursive: true });
    const existing = await optionalFile(archivePath);
    if (existing !== null) {
      assert(
        existing === text,
        "сохранённый исходник отличается от ожидаемого",
      );
    } else {
      await atomicFile(archivePath, text);
    }
  }
  await atomicFile(join(local, "status.json"), json(pending.status));
  const { status } = pending;
  const lines = [
    "# Доставка трекера",
    "",
    `Последнее успешное получение: ${status.lastSuccessAt}.`,
    `Данные полны до серверного среза: ${status.completeThrough}.`,
    `Доступная история начинается: ${status.historyStartedAt ?? "дата неизвестна"}.`,
    `Курсор: ${status.cursor}.`,
    "",
    status.lastBatch
      ? `Последняя порция: [JSON](${status.lastBatch}).`
      : "Новых изменений нет.",
    "",
    "Это состояние доставки. Оно не означает, что агент уже разобрал материалы и обновил страницы вики.",
    "Папки недель соответствуют времени получения серверного среза. Правки старых записей приходят в новых порциях.",
    "Исходные JSON сохраняют даты событий, записи и правок без подмены датой получения.",
    "",
  ];
  await atomicFile(join(sources, "Состояние.md"), lines.join("\n"));
  await unlink(join(local, "pending.json"));
}

async function acquireLock(path: string) {
  const existing = await optionalFile(path);
  if (existing !== null) {
    const pid = Number(existing);
    assert(Number.isSafeInteger(pid) && pid > 0, "повреждён файл блокировки");
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        running = false;
      } else {
        throw error;
      }
    }
    assert(!running, "доставка уже запущена");
    await unlink(path);
  }
  const candidate = `${path}.${randomUUID()}`;
  const lock = await open(candidate, "wx");
  try {
    await lock.writeFile(String(process.pid));
    await lock.sync();
  } finally {
    await lock.close();
  }
  try {
    // Жёсткая ссылка публикует готовый PID атомарно и не заменяет чужую блокировку.
    await link(candidate, path);
  } finally {
    await unlink(candidate);
  }
}

async function atomicFile(path: string, text: string) {
  const temp = `${path}.tmp`;
  const file = await open(temp, "w");
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

async function optionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function json(x: unknown) {
  return `${JSON.stringify(x, null, 2)}\n`;
}

export const onlyForTesting = { sync };
