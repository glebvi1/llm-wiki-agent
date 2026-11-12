/* eslint-disable n/no-process-env -- этот модуль задаёт окружение локального Telegram-процесса */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const windowsTaskName = "Gyromind Telegram Wiki";
export const windowsRuntimeRoot = join(packageRoot, ".runtime");
export const windowsStartupLog = join(windowsRuntimeRoot, "start.log");
const credentialSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().length(32),
});
export type TelegramCredentials = z.infer<typeof credentialSchema>;

export function runtimeRoot(): string {
  const appData = process.env.APPDATA;
  assert(appData, "APPDATA не задан");
  return join(appData, "Gyromind");
}

export function uvExecutable(): string {
  const installed = join(windowsRuntimeRoot, "uv.exe");
  const bundled = join(runtimeRoot(), "bin", "uv.exe");
  // eslint-disable-next-line n/no-sync -- проверка при запуске процесса
  return [installed, bundled].find(existsSync) ?? "uv";
}

export async function telegramCredentials(
  root: string,
): Promise<TelegramCredentials> {
  return credentialSchema.parse(
    JSON.parse(await readFile(join(root, "telegram-credentials.json"), "utf8")),
  );
}

export function telegramEnvironment(
  credentials: TelegramCredentials,
  root: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TELEGRAM_API_ID: String(credentials.apiId),
    TELEGRAM_API_HASH: credentials.apiHash,
    TELEGRAM_SESSION_NAME: join(root, "telegram-account"),
    TELEGRAM_SESSION_LOCK: "exclusive",
    TELEGRAM_EXPOSED_TOOLS: "read-only+send_message,save_draft",
    TELEGRAM_TRANSCRIBE: "off",
    MCP_TRANSPORT: "http",
    MCP_HOST: "127.0.0.1",
    MCP_PORT: "8765",
  };
}
