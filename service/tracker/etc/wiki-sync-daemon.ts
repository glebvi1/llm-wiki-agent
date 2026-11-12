import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const INTERVAL_MS = 15 * 60_000;

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const config = process.argv[2];
  assert(config, "укажите путь к настройкам доставки");
  const configPath = resolve(config);
  const folder = dirname(configPath);
  await mkdir(folder, { recursive: true });
  const identity = createHash("sha256")
    .update(configPath)
    .digest("hex")
    .slice(0, 16);
  // Именованный канал освобождается самой ОС при аварии, без устаревающего PID-файла.
  const singleton = createServer(function close(socket) {
    socket.end();
  });
  const claimed = await new Promise<boolean>(function listen(done, reject) {
    singleton.once("error", function failed(error: NodeJS.ErrnoException) {
      if (error.code === "EADDRINUSE") {
        done(false);
      } else {
        reject(error);
      }
    });
    singleton.listen(
      `\\\\.\\pipe\\gyromind-tracker-wiki-${identity}`,
      function ready() {
        done(true);
      },
    );
  });
  if (!claimed) {
    return;
  }
  const script = fileURLToPath(new URL("./wiki-sync.ts", import.meta.url));
  const firstDelayMs = Number(process.argv[3] ?? "10000");
  assert(Number.isSafeInteger(firstDelayMs) && firstDelayMs >= 0);
  await writeFile(
    join(folder, "tracker-wiki-daemon.json"),
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: INTERVAL_MS,
        nextRunAt: new Date(Date.now() + firstDelayMs).toISOString(),
      },
      null,
      2,
    ),
  );
  await schedule(
    async function deliver() {
      let success = false;
      let output =
        "не удалось получить трекер; предыдущая завершённая выгрузка сохранена\n";
      try {
        const result = await exec(process.execPath, [script, configPath], {
          windowsHide: true,
          timeout: 9 * 60_000,
          maxBuffer: 1024 * 1024,
        });
        success = true;
        output = result.stdout;
      } catch {
        // Исключение дочернего процесса может содержать окружение; в журнал идёт только итог.
      }
      await writeFile(join(folder, "tracker-wiki-sync.log"), output, "utf8");
      await writeFile(
        join(folder, "tracker-wiki-daemon.json"),
        JSON.stringify(
          {
            pid: process.pid,
            lastRunAt: new Date().toISOString(),
            success,
            intervalMs: INTERVAL_MS,
            nextRunAt: new Date(Date.now() + INTERVAL_MS).toISOString(),
          },
          null,
          2,
        ),
      );
    },
    { firstDelayMs, intervalMs: INTERVAL_MS },
  );
}

async function schedule(
  run: () => Promise<void>,
  options: { firstDelayMs: number; intervalMs: number; signal?: AbortSignal },
) {
  const { firstDelayMs, intervalMs, signal } = options;
  let delay = firstDelayMs;
  while (!signal?.aborted) {
    try {
      await setTimeout(delay, undefined, signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      throw error;
    }
    try {
      await run();
    } catch {
      /* Сбой одной доставки не останавливает расписание. */
    }
    delay = intervalMs;
  }
}

export const onlyForTesting = { schedule };
