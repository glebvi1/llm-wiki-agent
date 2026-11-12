import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

// Вызывается только механизмом http_headers_helper Codex. stdout — канал секрета
// к MCP-транспорту, его нельзя запускать вручную или копировать в журнал.
try {
  const filename = join(
    userInfo().homedir,
    "AppData",
    "Roaming",
    "Gyromind",
    "tracker-wiki.json",
  );
  const settings: unknown = JSON.parse(await readFile(filename, "utf8"));
  assert(
    typeof settings === "object" && settings !== null && "token" in settings,
  );
  assert(typeof settings.token === "string" && settings.token.length >= 32);
  process.stdout.write(
    JSON.stringify({ Authorization: `Bearer ${settings.token}` }),
  );
} catch {
  console.error("не удалось прочитать настройки подключения трекера");
  process.exitCode = 1;
}
