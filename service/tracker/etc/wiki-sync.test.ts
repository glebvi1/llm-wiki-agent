import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { onlyForTesting } from "./wiki-sync.ts";

const { sync } = onlyForTesting;
const capturedAt = "2026-10-25T12:00:00.000Z";

describe(sync, () => {
  it("принимает пропуски sequence и повторное пустое получение без нового архива", async () => {
    const harness = await setup();
    try {
      harness.gap = true;
      expect((await sync(harness.config)).cursor).toBe("20");
      await sync(harness.config);
      await expect(
        readdir(join(harness.sources, "2026-10-19")),
      ).resolves.toStrictEqual(["0-20.json"]);
      expect(harness.requests).toStrictEqual(["0", "10", "20"]);
    } finally {
      await harness.close();
    }
  });

  it("не конкурирует с живым получателем и восстанавливает блокировку умершего процесса", async () => {
    const harness = await setup();
    try {
      const lock = join(harness.local, "sync.lock");
      await writeFile(lock, String(process.pid));
      await expect(sync(harness.config)).rejects.toThrow(
        "доставка уже запущена",
      );
      const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
      await once(child, "exit");
      const { pid } = child;
      if (pid === undefined) {
        throw new Error("тестовый процесс не получил PID");
      }
      await writeFile(lock, String(pid));
      expect((await sync(harness.config)).cursor).toBe("2");
      await expect(readdir(harness.local)).resolves.toStrictEqual([
        "status.json",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("сохраняет страницы целиком, старые изменения и новую границу отдельно от обработки агентом", async () => {
    const harness = await setup();
    try {
      const first = await sync(harness.config);
      expect(first.cursor).toBe("2");
      expect(first.completeThrough).toBe(capturedAt);
      expect(harness.requests).toStrictEqual(["0", "1"]);
      const batch: unknown = JSON.parse(
        await readFile(join(harness.sources, "2026-10-19", "0-2.json"), "utf8"),
      );
      expect(batch).toMatchObject({
        pages: [
          {
            snapshot: { journal: [{ body: "Полный текст" }] },
            historyCoverage: { task: "2026-10-01" },
          },
          {
            changes: [
              { operation: "deleted", recordedAt: "2026-10-01T12:00:00.000Z" },
            ],
          },
        ],
      });
      const status = await readFile(
        join(harness.sources, "Состояние.md"),
        "utf8",
      );
      expect(status).toContain("не означает, что агент уже разобрал");
      await sync(harness.config);
      await expect(
        readdir(join(harness.sources, "2026-10-19")),
      ).resolves.toStrictEqual(["0-2.json"]);
    } finally {
      await harness.close();
    }
  });

  it("после обрыва не меняет курсор, повторно получает порции без дублей", async () => {
    const harness = await setup();
    try {
      harness.fail = true;
      await expect(sync(harness.config)).rejects.toThrow("ошибка HTTP 503");
      await expect(readdir(harness.sources)).resolves.toStrictEqual([]);
      await expect(readdir(harness.local)).resolves.toStrictEqual([]);
      harness.fail = false;
      expect((await sync(harness.config)).cursor).toBe("2");
      expect(harness.requests).toStrictEqual(["0", "1", "0", "1"]);
    } finally {
      await harness.close();
    }
  });

  it("не принимает дрейф границы и некорректный порядок событий", async () => {
    const harness = await setup();
    try {
      harness.drift = true;
      await expect(sync(harness.config)).rejects.toThrow(
        "граница выгрузки изменилась",
      );
      harness.drift = false;
      harness.reverse = true;
      await expect(sync(harness.config)).rejects.toThrow(
        "нарушен порядок истории",
      );
      await expect(readdir(harness.sources)).resolves.toStrictEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("восстанавливает завершённый пакет после сбоя до записи состояния", async () => {
    const harness = await setup();
    try {
      const status = {
        schemaVersion: 1,
        cursor: "2",
        lastSuccessAt: capturedAt,
        completeThrough: capturedAt,
        historyStartedAt: capturedAt,
        lastBatch: "2026-10-19/0-2.json",
      };
      await writeFile(
        join(harness.local, "pending.json"),
        JSON.stringify({
          archive: { relativePath: status.lastBatch, text: "original\n" },
          status,
        }),
      );
      expect((await sync(harness.config)).cursor).toBe("2");
      await expect(
        readFile(join(harness.sources, status.lastBatch), "utf8"),
      ).resolves.toBe("original\n");
      expect(harness.requests).toStrictEqual(["2"]);
    } finally {
      await harness.close();
    }
  });
});

async function setup() {
  const wikiRoot = await mkdtemp(join(tmpdir(), "tracker-wiki-"));
  const requests: string[] = [];
  const harness = {
    fail: false,
    drift: false,
    reverse: false,
    gap: false,
    requests,
    config: { baseUrl: "", token: "t".repeat(32), wikiRoot },
    sources: join(wikiRoot, "Исходники", "Трекер"),
    local: join(wikiRoot, ".local", "tracker-sync"),
    async close() {
      server.close();
      await once(server, "close");
      await rm(wikiRoot, { recursive: true, force: true });
    },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const after = url.searchParams.get("after") ?? "0";
    requests.push(after);
    if (request.headers.authorization !== `Bearer ${harness.config.token}`) {
      response.writeHead(401).end();
      return;
    }
    if (after === "1" && harness.fail) {
      response.writeHead(503).end();
      return;
    }
    const second = after !== "0";
    const until = harness.gap ? "20" : "2";
    const cursor = second ? until : harness.gap ? "10" : "1";
    const changes =
      after === until
        ? []
        : [
            {
              sequence: harness.reverse ? "0" : cursor,
              entityType: "task",
              entityId: "task-1",
              operation: second ? "deleted" : "present",
              recordedAt: "2026-10-01T12:00:00.000Z",
              payload: { title: "Задача" },
            },
          ];
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          schemaVersion: 1,
          capturedAt,
          historyStartedAt: capturedAt,
          historyCoverage: { task: "2026-10-01" },
          until: second && harness.drift ? "3" : until,
          cursor,
          complete: second,
          changes,
          ...(second
            ? {}
            : { snapshot: { journal: [{ body: "Полный текст" }] } }),
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("тестовый сервер не получил порт");
  }
  harness.config.baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(harness.local, { recursive: true });
  return harness;
}
