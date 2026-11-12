/* eslint-disable n/no-process-env -- единственная точка чтения окружения сервера */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const settingsSchema = z.object({
  wikiRoot: z.string().min(1),
  token: z.string().min(32),
  telegramMcpUrl: z.url().default("http://127.0.0.1:8765/mcp"),
  codexPath: z.string().min(1).default("codex"),
});

export interface AppConfig {
  wikiRoot: string;
  token: string;
  telegramMcpUrl: string;
  codexPath: string;
  port: number;
  syncIntervalMs: number;
  enableSync: boolean;
  gatewayEnabled: boolean;
}

export async function loadConfig(path?: string): Promise<AppConfig> {
  const appData = process.env.APPDATA;
  assert(appData, "APPDATA не задан");
  const filename =
    path ??
    process.env.TELEGRAM_WIKI_CONFIG ??
    join(appData, "Gyromind", "telegram-wiki.json");
  const parsed = settingsSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const upstream = new URL(parsed.telegramMcpUrl);
  assert(
    ["127.0.0.1", "localhost", "::1"].includes(upstream.hostname),
    "Telegram MCP должен быть локальным",
  );
  assert(
    upstream.protocol === "http:",
    "Локальный Telegram MCP должен использовать http",
  );
  return {
    wikiRoot: resolve(parsed.wikiRoot),
    token: parsed.token,
    telegramMcpUrl: parsed.telegramMcpUrl,
    codexPath: parsed.codexPath,
    port: Number(process.env.PORT ?? "7100"),
    syncIntervalMs: Number(process.env.TELEGRAM_SYNC_INTERVAL_MS ?? "60000"),
    enableSync: process.env.ENABLE_TELEGRAM_SYNC !== "0",
    gatewayEnabled: process.env.ENABLE_TELEGRAM_GATEWAY !== "0",
  };
}

export function developmentConfig(): AppConfig {
  const wikiRoot =
    process.env.TELEGRAM_WIKI_ROOT ?? join(packageRoot, "temp", "wiki");
  return {
    wikiRoot,
    token:
      process.env.TELEGRAM_WIKI_TOKEN ??
      "development-only-token-change-me-32-chars",
    telegramMcpUrl: process.env.TELEGRAM_MCP_URL ?? "http://127.0.0.1:8765/mcp",
    codexPath: process.env.CODEX_CLI_PATH ?? "codex",
    port: Number(process.env.PORT ?? "7100"),
    syncIntervalMs: Number(process.env.TELEGRAM_SYNC_INTERVAL_MS ?? "60000"),
    enableSync: process.env.ENABLE_TELEGRAM_SYNC === "1",
    gatewayEnabled: process.env.ENABLE_TELEGRAM_GATEWAY === "1",
  };
}
