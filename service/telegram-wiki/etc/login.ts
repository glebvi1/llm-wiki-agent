import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import * as z from "zod/v4";

import { atomicJson, isMissing } from "#src/server/store.ts";

import { markTelegramConnected } from "./install.ts";
import {
  packageRoot,
  runtimeRoot,
  telegramCredentials,
  telegramEnvironment,
  uvExecutable,
} from "./runtime.ts";

const root = runtimeRoot();
const credentials = await credentialsOrPrompt(root);
const config = z
  .object({ wikiRoot: z.string() })
  .parse(JSON.parse(await readFile(join(root, "telegram-wiki.json"), "utf8")));
const child = spawn(
  uvExecutable(),
  [
    "--directory",
    join(packageRoot, "vendor", "telegram-mcp"),
    "run",
    "python",
    join(packageRoot, "etc", "login.py"),
  ],
  {
    cwd: packageRoot,
    env: telegramEnvironment(credentials, root),
    stdio: "inherit",
  },
);
const code = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
assert(code === 0, "вход в Telegram не завершён");
await markTelegramConnected(config.wikiRoot);

async function credentialsOrPrompt(root: string) {
  try {
    return await telegramCredentials(root);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      "Создайте приложение на https://my.telegram.org/apps. Это не токен бота.",
    );
    const apiId = Number((await rl.question("API ID: ")).trim());
    const apiHash = (await rl.question("API Hash: ")).trim();
    assert(
      Number.isSafeInteger(apiId) && apiId > 0,
      "API ID должен быть положительным числом",
    );
    assert(
      /^[a-f0-9]{32}$/i.test(apiHash),
      "API Hash должен содержать 32 шестнадцатеричных символа",
    );
    const value = { apiId, apiHash };
    await atomicJson(join(root, "telegram-credentials.json"), value);
    return value;
  } finally {
    rl.close();
  }
}
