import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

import { atomicJson, isMissing } from "#src/server/store.ts";

import {
  windowsRuntimeRoot,
  windowsStartupLog,
  windowsTaskName,
} from "./runtime.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const configSchema = z.object({
  wikiRoot: z.string(),
  token: z.string().min(32),
  telegramMcpUrl: z.string(),
  codexPath: z.string(),
});

export interface InstallOptions {
  wikiRoot: string;
  appDataRoot: string;
  codexHome: string;
  codexPath: string;
  nodePath: string;
  projectId?: string;
}

export async function installWiki(
  options: InstallOptions,
): Promise<{ configPath: string; automationPath: string }> {
  const wikiRoot = resolve(options.wikiRoot);
  assert(
    await exists(join(wikiRoot, "AGENTS.md")),
    "в корне Wiki нет AGENTS.md",
  );
  assert(
    await exists(join(wikiRoot, "Правила LLM Wiki.md")),
    "в корне Wiki нет Правила LLM Wiki.md",
  );
  const backupRoot = join(
    wikiRoot,
    ".local",
    "telegram-wiki",
    "install-backup",
    new Date().toISOString().replaceAll(":", "-"),
  );
  const skillSource = join(packageRoot, "wiki", "skill");
  const skillTarget = join(
    wikiRoot,
    ".agents",
    "skills",
    "wiki-telegram-ingest",
  );
  for (const source of await filesUnder(skillSource)) {
    const name = relative(skillSource, source);
    const target = join(skillTarget, name);
    if (name === "approval.json" && (await exists(target))) {
      continue;
    }
    await backup(wikiRoot, backupRoot, target);
    await atomicText(target, await readFile(source, "utf8"));
  }

  const agentsPath = join(wikiRoot, "AGENTS.md");
  const rulesPath = join(wikiRoot, "Правила LLM Wiki.md");
  await backup(wikiRoot, backupRoot, agentsPath);
  await atomicText(
    agentsPath,
    updateAgents(
      await readFile(agentsPath, "utf8"),
      await readFile(join(packageRoot, "wiki", "telegram-agents.md"), "utf8"),
    ),
  );
  await backup(wikiRoot, backupRoot, rulesPath);
  await atomicText(
    rulesPath,
    updateRules(
      await readFile(rulesPath, "utf8"),
      await readFile(join(packageRoot, "wiki", "telegram-rules.md"), "utf8"),
    ),
  );

  const configPath = join(options.appDataRoot, "telegram-wiki.json");
  const previous = await readOptional(configPath);
  const parsed =
    previous === null ? null : configSchema.safeParse(JSON.parse(previous));
  const token = parsed?.success
    ? parsed.data.token
    : randomBytes(32).toString("hex");
  await atomicJson(configPath, {
    wikiRoot,
    token,
    telegramMcpUrl: "http://127.0.0.1:8765/mcp",
    codexPath: options.codexPath,
  });

  const projectConfig = join(wikiRoot, ".codex", "config.toml");
  const currentConfig =
    (await readOptional(projectConfig)) ??
    "mcp_optional_startup_grace_ms = 0\n";
  if (!currentConfig.includes("[mcp_servers.telegram]")) {
    const helper =
      `${options.nodePath} ${join(packageRoot, "src", "server", "mcp-headers.ts")}`.replaceAll(
        "\\",
        "/",
      );
    const block = [
      "",
      "[mcp_servers.telegram]",
      'url = "http://127.0.0.1:7100/api/mcp"',
      `http_headers_helper = ${JSON.stringify(helper)}`,
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 180",
      'default_tools_approval_mode = "auto"',
      "",
    ].join("\n");
    await backup(wikiRoot, backupRoot, projectConfig);
    await atomicText(projectConfig, `${currentConfig.trimEnd()}\n${block}`);
  }

  const automationPath = join(
    options.codexHome,
    "automations",
    "telegram-wiki",
    "automation.toml",
  );
  await backup(
    wikiRoot,
    backupRoot,
    automationPath,
    "external-automation.toml",
  );
  await atomicText(
    automationPath,
    automation(
      options.wikiRoot,
      options.projectId ?? "af61f5fd-8198-47e7-8061-220855ba82ad",
    ),
  );
  return { configPath, automationPath };
}

export function updateAgents(text: string, block: string): string {
  let result = text;
  if (!result.includes("wiki-telegram-ingest/SKILL.md")) {
    const trackerBullet = [
      "- Обновление вики по доставленным данным трекера или ответ на открытый вопрос",
      "этого процесса, в том числе в чате Codex —",
      "[wiki-tracker-ingest](.agents/skills/wiki-tracker-ingest/SKILL.md).",
      "Сначала проверь принятие версии скилла; до принятия разрешены подготовка и проверки.",
    ].join(" ");
    const telegramBullet = [
      "- Обновление вики по доставленной переписке Telegram или ответ на открытый вопрос",
      "этого процесса —",
      "[wiki-telegram-ingest](.agents/skills/wiki-telegram-ingest/SKILL.md).",
      "Сначала проверь принятие версии скилла; до принятия разрешены подготовка и проверки.",
    ].join(" ");
    result = result.includes(trackerBullet)
      ? result.replace(trackerBullet, `${trackerBullet}\n${telegramBullet}`)
      : `${result.trimEnd()}\n\n${telegramBullet}\n`;
  }
  if (!result.includes("## Telegram")) {
    result = `${result.trimEnd()}\n${block}`;
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function updateRules(text: string, block: string): string {
  const oldTask = [
    "- [ ] **Подключить Telegram.** Сделать удобный способ работать с вики из Telegram.",
    "Как именно — решим, когда займёмся подключением.",
  ].join(" ");
  const oldRule = [
    "Telegram пока остаётся задачей на будущее;",
    "без отдельного поручения его не настраиваем.",
  ].join(" ");
  let result = text
    .replace(oldTask, pendingConnectionTask())
    .replace(oldRule, pendingConnectionRule())
    .replace(
      "в 09:07 по Москве, проверять новые порции",
      "в 09:00 по Москве, проверять новые порции",
    );
  if (!result.includes("### Автоматическое обновление из Telegram")) {
    const anchor = "## Как работать с источниками";
    result = result.includes(anchor)
      ? result.replace(anchor, `${block.trim()}\n\n${anchor}`)
      : `${result.trimEnd()}\n${block}`;
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

export async function markTelegramConnected(wikiRoot: string): Promise<void> {
  const path = join(wikiRoot, "Правила LLM Wiki.md");
  const text = await readFile(path, "utf8");
  const connected = text
    .replace(
      pendingConnectionTask(),
      [
        "- [x] **Подключить Telegram.** Личный аккаунт авторизован",
        "через локальный клиентский API;",
        "обработка Wiki включается после принятия скилла.",
      ].join(" "),
    )
    .replace(
      pendingConnectionRule(),
      [
        "Аккаунт авторизован;",
        "смысловая обработка остаётся выключенной до принятия скилла.",
      ].join(" "),
    );
  await atomicText(path, connected);
}

function pendingConnectionTask(): string {
  return [
    "- [ ] **Завершить подключение Telegram.** Локальная интеграция установлена;",
    "осталось авторизовать личный аккаунт и принять скилл обработки.",
  ].join(" ");
}

function pendingConnectionRule(): string {
  return [
    "До авторизации аккаунта и принятия скилла",
    "Telegram не является активным источником Wiki.",
  ].join(" ");
}

export async function installStartupTask(
  appDataRoot: string,
  nodePath: string,
): Promise<void> {
  // Electron в режиме Node тоже сообщает свою версию Node, но Windows откроет его приложение.
  assert(/(?:^|[\\/])node(?:\.exe)?$/i.test(nodePath), "нужен путь к Node.js");
  await mkdir(windowsRuntimeRoot, { recursive: true });
  const openLauncher = join(windowsRuntimeRoot, "open.vbs");
  const iconBytes = await readFile(
    join(packageRoot, "etc", "telegram-wiki.ico"),
  );
  const iconStamp = createHash("sha256")
    .update(iconBytes)
    .digest("hex")
    .slice(0, 8);
  const icon = join(windowsRuntimeRoot, `telegram-wiki-${iconStamp}.ico`);
  const script = join(packageRoot, "etc", "start.ts");
  const command = `"${nodePath}" --experimental-transform-types "${script}"`;
  await atomicText(
    openLauncher,
    hiddenLaunch(`${command} --installed`),
    "utf16le",
  );
  await writeFile(icon, iconBytes);
  try {
    await copyFile(
      join(appDataRoot, "bin", "uv.exe"),
      join(windowsRuntimeRoot, "uv.exe"),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (
      !isMissing(error) &&
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  installShortcuts(appDataRoot, openLauncher, icon, nodePath, script);
}

function hiddenLaunch(command: string): string {
  return [
    "\uFEFFOn Error Resume Next",
    `result = CreateObject("WScript.Shell").Run(${vbsQuote(command)}, 0, True)`,
    "If Err.Number <> 0 Then result = 1",
    [
      'If result <> 0 Then MsgBox "Не удалось открыть Telegram в LLM Wiki.',
      `" & vbCrLf & ${vbsQuote(windowsStartupLog)}, vbExclamation, "Telegram в LLM Wiki"`,
    ].join(" "),
    "WScript.Quit result",
    "",
  ].join("\r\n");
}

function installShortcuts(
  appDataRoot: string,
  openLauncher: string,
  icon: string,
  nodePath: string,
  entry: string,
): void {
  const background = Buffer.from(
    [
      "$ErrorActionPreference = 'Stop'",
      `$env:APPDATA = ${powerShellQuote(dirname(appDataRoot))}`,
      `$log = ${powerShellQuote(windowsStartupLog)}`,
      'Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format o)] Фоновый запуск Telegram Wiki"',
      `& ${powerShellQuote(nodePath)} --experimental-transform-types ${powerShellQuote(entry)} --background`,
      "exit $LASTEXITCODE",
    ].join("\r\n"),
    "utf16le",
  ).toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    '$wscript = Join-Path $env:SystemRoot "System32\\wscript.exe"',
    '$powershell = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    `$working = ${powerShellQuote(packageRoot)}`,
    `$icon = ${powerShellQuote(icon)}`,
    "$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${background}'`,
    "$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $working",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    [
      "$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable",
      "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
      "-RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    ].join(" "),
    [
      `Register-ScheduledTask -TaskName ${powerShellQuote(windowsTaskName)} -Action $action -Trigger $trigger`,
      "-Principal $principal -Settings $settings -Force | Out-Null",
    ].join(" "),
    "function New-TelegramShortcut($folder, $launcher) {",
    "  $shortcut = $shell.CreateShortcut((Join-Path $folder 'Telegram в LLM Wiki.lnk'))",
    "  $shortcut.TargetPath = $wscript",
    '  $shortcut.Arguments = "//NoLogo `"$launcher`""',
    "  $shortcut.WorkingDirectory = $working",
    '  $shortcut.IconLocation = "$icon,0"',
    "  $shortcut.Description = 'Открыть Telegram в LLM Wiki'",
    "  $shortcut.Save()",
    "}",
    `New-TelegramShortcut ([Environment]::GetFolderPath('DesktopDirectory')) ${powerShellQuote(openLauncher)}`,
    `New-TelegramShortcut ([Environment]::GetFolderPath('Programs')) ${powerShellQuote(openLauncher)}`,
    "$old = Join-Path ([Environment]::GetFolderPath('Startup')) 'Telegram в LLM Wiki.lnk'",
    `$oldLauncher = ${powerShellQuote(join(appDataRoot, "start-background.vbs"))}`,
    "if ((Test-Path -LiteralPath $old) -and $shell.CreateShortcut($old).Arguments.Contains($oldLauncher)) {",
    "  Remove-Item -LiteralPath $old",
    "}",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // eslint-disable-next-line n/no-sync
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    const detail =
      result.error?.message || result.stderr.trim() || String(result.status);
    throw new Error(`не удалось настроить запуск Telegram Wiki: ${detail}`);
  }
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function automation(wikiRoot: string, projectId: string): string {
  const prompt = [
    "Работай в проекте LLM Wiki.",
    "На каждом запуске используй $wiki-telegram-ingest",
    "из .agents/skills/wiki-telegram-ingest/SKILL.md.",
    "Не опирайся на историю чата: инструкции, источники, вопросы",
    "и место продолжения читай из файлов и telegram ingest_status.",
    "Продолжай activeRun. Если версия скилла не принята,",
    "ничего не меняй и не принимай её за Глеба.",
    "Понятные изменения вноси сам;",
    "вопрос сохраняй с одной задачей на сегодня по Москве.",
    "Принимай ответы из карточки и любого чата Codex.",
    "Не создавай дубли, не отправляй сообщения и не меняй настройки получателя.",
    "Не уведомляй при пустой очереди;",
    "сообщай о новых вопросах, заметном результате или сбое.",
  ].join(" ");
  const now = Date.now();
  return [
    "version = 1",
    'id = "telegram-wiki"',
    'kind = "cron"',
    'name = "Обновлять вики из Telegram"',
    `prompt = ${JSON.stringify(prompt)}`,
    'status = "ACTIVE"',
    'rrule = "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"',
    'model = "gpt-6.1-sol"',
    'reasoning_effort = "high"',
    'execution_environment = "local"',
    `target = { type = "project", project_id = "${projectId}" }`,
    `cwds = [${JSON.stringify(wikiRoot)}]`,
    `created_at = ${String(now)}`,
    `updated_at = ${String(now)}`,
    "",
  ].join("\n");
}

async function backup(
  wikiRoot: string,
  backupRoot: string,
  path: string,
  externalName?: string,
): Promise<void> {
  const text = await readOptional(path);
  if (text === null) {
    return;
  }
  const name = externalName ?? relative(wikiRoot, path);
  if (!externalName) {
    assert(
      !name.startsWith(".."),
      "резервная копия должна оставаться внутри Wiki",
    );
  }
  await atomicText(join(backupRoot, name), text);
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

async function atomicText(
  path: string,
  text: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, text, encoding);
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await readOptional(path)) !== null;
}

function vbsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}
