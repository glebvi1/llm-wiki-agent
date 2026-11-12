import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const config = process.argv[2];
  assert(config, "укажите настройки доставки");
  if (!(await deliver(resolve(config)))) {
    process.exitCode = 1;
  }
}

async function deliver(config: string, launch = launchSync): Promise<boolean> {
  const folder = dirname(config);
  await mkdir(folder, { recursive: true });
  const startedAt = new Date().toISOString();
  let success = false;
  let output =
    "не удалось получить трекер; предыдущая завершённая выгрузка сохранена\n";
  try {
    output = await launch(config);
    success = true;
  } catch {
    // Ошибка процесса может содержать секреты, поэтому в журнал идёт только итог.
  }
  await writeFile(join(folder, "last-run.log"), output, "utf8");
  const status = join(folder, "schedule-status.json");
  await writeFile(
    `${status}.tmp`,
    JSON.stringify(
      {
        manager: "Windows Task Scheduler",
        taskName: "Gyromind Tracker Wiki",
        startedAt,
        finishedAt: new Date().toISOString(),
        success,
        intervalMinutes: 15,
        executable: process.execPath,
      },
      null,
      2,
    ),
    "utf8",
  );
  await rename(`${status}.tmp`, status);
  return success;
}

async function launchSync(config: string): Promise<string> {
  const script = fileURLToPath(new URL("./wiki-sync.ts", import.meta.url));
  const result = await exec(process.execPath, [script, config], {
    windowsHide: true,
    timeout: 9 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

export const onlyForTesting = { deliver };
