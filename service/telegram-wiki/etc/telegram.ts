import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  packageRoot,
  runtimeRoot,
  telegramCredentials,
  telegramEnvironment,
  uvExecutable,
} from "./runtime.ts";

const root = runtimeRoot();
const credentials = await telegramCredentials(root);
const child = spawn(
  uvExecutable(),
  [
    "--directory",
    join(packageRoot, "vendor", "telegram-mcp"),
    "run",
    "main.py",
  ],
  {
    cwd: packageRoot,
    env: telegramEnvironment(credentials, root),
    stdio: "inherit",
    windowsHide: true,
  },
);

child.once("error", () => {
  console.error("не удалось запустить uv для Telegram MCP");
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
