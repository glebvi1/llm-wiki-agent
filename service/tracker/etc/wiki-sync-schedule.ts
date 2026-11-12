import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as v from "valibot";

const exec = promisify(execFile);

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  assert(process.platform === "win32", "задание предназначено для Windows");
  const config = process.argv[2];
  assert(config, "укажите путь к tracker-wiki.json");
  const contents = await readFile(resolve(config), "utf8");
  const settings = v.parse(
    v.object({ wikiRoot: v.string() }),
    JSON.parse(contents),
  );
  // Store-приложение перенаправляет AppData в свою папку. Планировщик запускается
  // вне этого окружения, поэтому установка находится рядом с вики, вне её Git.
  const folder = join(
    dirname(resolve(settings.wikiRoot)),
    ".tracker-wiki-runtime",
  );
  await mkdir(folder, { recursive: true });
  // eslint-disable-next-line n/no-process-env -- поиск штатных программ Windows
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot);
  const powershell = resolve(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const node = join(folder, "node.exe");
  const configPath = join(folder, "settings.json");
  const runner = fileURLToPath(new URL("./wiki-sync-run.ts", import.meta.url));
  const launcher = join(folder, "run.vbs");
  const plan = installationPlan(
    node,
    runner,
    configPath,
    launcher,
    folder,
    resolve(systemRoot),
  );
  await exec(
    powershell,
    encoded(
      [
        "$ErrorActionPreference = 'Stop'",
        "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        `& icacls.exe ${quote(folder)} /inheritance:r ` +
          `/grant:r ("*" + $sid + ":(OI)(CI)F") '*S-1-5-18:(OI)(CI)F' | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'не удалось защитить настройки' }",
      ].join("\r\n"),
    ),
    { windowsHide: true },
  );
  if (resolve(process.execPath) !== resolve(node)) {
    const source = await readFile(process.execPath);
    const previous = await readFile(node).catch(() => null);
    if (previous === null || !source.equals(previous)) {
      await copyFile(process.execPath, node);
    }
  }
  await writeFile(configPath, contents, "utf8");
  await writeFile(launcher, `\uFEFF${plan.launcher}\r\n`, "utf16le");
  await exec(powershell, encoded(plan.install), { windowsHide: true });
  console.log(
    "доставка настроена: задание Windows каждые 15 минут, при входе и после пропущенного запуска",
  );
  console.log(`состояние доставки: ${join(folder, "schedule-status.json")}`);
}

function installationPlan(
  node: string,
  runner: string,
  config: string,
  launcher: string,
  folder: string,
  systemRoot: string,
) {
  const command = [node, runner, config].map((path) => `"${path}"`).join(" ");
  const vbs = `WScript.Quit CreateObject("WScript.Shell").Run("${command.replaceAll('"', '""')}", 0, True)`;
  const install = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$action = New-ScheduledTaskAction -Execute " +
      quote(join(systemRoot, "System32", "wscript.exe")) +
      " " +
      `-Argument ${quote(`//B //Nologo "${launcher}"`)} -WorkingDirectory ${quote(folder)}`,
    "$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited",
    "$timer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `" +
      "\r\n  -RepetitionInterval (New-TimeSpan -Minutes 15)",
    "$login = New-ScheduledTaskTrigger -AtLogOn -User $sid",
    "$options = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `",
    "  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `",
    "  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    "Register-ScheduledTask -TaskName 'Gyromind Tracker Wiki' -Action $action -Principal $principal `",
    "  -Trigger @($timer, $login) -Settings $options -Force | Out-Null",
    "Start-ScheduledTask -TaskName 'Gyromind Tracker Wiki'",
    "Remove-ItemProperty -Path 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run' `",
    "  -Name 'Gyromind Tracker Wiki' -ErrorAction SilentlyContinue",
    "exit 0",
  ].join("\r\n");
  return { launcher: vbs, install };
}

function encoded(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export const onlyForTesting = { installationPlan };
