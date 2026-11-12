/* eslint-disable n/no-process-env -- CLI читает пути Windows и Codex из окружения пользователя */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { isMissing } from "#src/server/store.ts";

import {
  defaultCodexHome,
  installStartupTask,
  installWiki,
} from "./install.ts";

await main();

async function main(): Promise<void> {
  const appData = process.env.APPDATA;
  assert(appData, "APPDATA не задан");
  const args = process.argv.slice(2);
  const wikiArgument = optionValue(args, "--wiki");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let wikiRoot: string;
  try {
    wikiRoot =
      (wikiArgument ??
        (await rl.question("Путь к Wiki: ")).trim());
  } finally {
    rl.close();
  }
  assert(wikiRoot, "укажите путь к Wiki");
  const projectConfig = join(wikiRoot, ".codex", "config.toml");
  const existingProjectConfig = await optionalText(projectConfig);
  const globalConfig = await optionalText(
    join(homedir(), ".codex", "config.toml"),
  );
  const codexPath =
    process.env.CODEX_CLI_PATH ??
    /CODEX_CLI_PATH = '([^']+)'/.exec(globalConfig ?? "")?.[1] ??
    "codex";
  const helper = /http_headers_helper = "([^"]+)"/.exec(
    existingProjectConfig ?? "",
  )?.[1];
  const nodePath =
    process.env.TELEGRAM_WIKI_NODE ??
    helper?.match(/^(.+?node\.exe)\s/i)?.[1] ??
    process.execPath;
  const appDataRoot = join(appData, "Gyromind");
  const result = await installWiki({
    wikiRoot: resolve(wikiRoot),
    appDataRoot,
    codexHome: defaultCodexHome(),
    codexPath,
    nodePath,
  });
  if (!args.includes("--no-startup")) {
    await installStartupTask(appDataRoot, nodePath);
  }
  console.log(
    "Интеграция установлена. Секреты и сессия будут храниться в %APPDATA%\\Gyromind.",
  );
  console.log(`Локальная конфигурация: ${result.configPath}`);
  console.log(`Расписание Codex: ${result.automationPath}`);
  console.log(
    "Откройте приложение ярлыком «Telegram в LLM Wiki» на рабочем столе и нажмите «Авторизоваться».",
  );
  console.log(
    "Если API ID/hash ещё не сохранены, сначала выполните: pnpm --filter telegram-wiki login.",
  );
  console.log(
    "После проверки скилла явно примите его версию в Codex; до этого Wiki не изменяется.",
  );
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}
