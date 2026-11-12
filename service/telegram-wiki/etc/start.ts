/* eslint-disable n/no-process-env -- окно запускается с окружением текущего пользователя */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import * as z from "zod/v4";

import {
  packageRoot,
  windowsRuntimeRoot,
  windowsStartupLog,
  windowsTaskName,
} from "./runtime.ts";

const url = "http://127.0.0.1:7100/";
const health = z.object({
  result: z.object({ service: z.literal("telegram-wiki") }),
});
try {
  await mkdir(windowsRuntimeRoot, { recursive: true });
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await appendFile(
    windowsStartupLog,
    `${new Date().toISOString()} ${message}\n`,
  ).catch(() => undefined);
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const background = process.argv.includes("--background");
  let server: ChildProcess | undefined;
  if (!(await healthy())) {
    if (process.argv.includes("--installed")) {
      requestBackgroundStart();
    } else {
      server = await launch();
    }
    await ready(server);
  }
  if (!background) {
    await openInterface();
  }
  if (server) {
    await supervise(server);
  }
}

function requestBackgroundStart(): void {
  // eslint-disable-next-line n/no-sync -- планировщик возвращает результат запроса запуска
  const result = spawnSync("schtasks.exe", ["/Run", "/TN", windowsTaskName], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5000,
  });
  assert(result.status === 0, "Windows не запустила службу Telegram Wiki");
}

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${url}api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return false;
    }
    return health.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

async function launch(): Promise<ChildProcess> {
  const log = await open(windowsStartupLog, "a");
  try {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        join(packageRoot, "src", "server", "index.ts"),
      ],
      {
        cwd: packageRoot,
        stdio: ["ignore", log.fd, log.fd],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  } finally {
    await log.close();
  }
}

async function ready(child: ChildProcess | undefined): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert(!child || child.exitCode === null, "Telegram Wiki не запустился");
    if (await healthy()) {
      return;
    }
    await delay(200);
  }
  throw new Error("Telegram Wiki не ответил в течение 30 секунд");
}

async function openInterface(): Promise<void> {
  const executable: unknown = createRequire(import.meta.url)("electron");
  assert(typeof executable === "string", "не найдено приложение Telegram Wiki");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const window = spawn(
    executable,
    [join(packageRoot, "etc", "window.mts"), url],
    {
      stdio: "ignore",
      detached: true,
      env,
    },
  );
  await new Promise<void>((resolve, reject) => {
    window.once("spawn", resolve);
    window.once("error", reject);
  });
  window.unref();
}

async function supervise(child: ChildProcess): Promise<void> {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopTree(child);
    });
  }
  const code =
    child.exitCode ??
    (await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    }));
  process.exitCode = code ?? 0;
}

function stopTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    // Останавливаем и Node, и его Telegram-потомков, чтобы не оставить владельца SessionLock.
    // eslint-disable-next-line n/no-sync
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
