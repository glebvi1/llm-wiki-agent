import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

import * as z from "zod/v4";

import {
  packageRoot,
  runtimeRoot,
  telegramCredentials,
  telegramEnvironment,
  uvExecutable,
} from "#etc/runtime.ts";
import type { AppConfig } from "#src/server/config.ts";
import { isMissing } from "#src/server/store.ts";

export type TelegramConnection = {
  status:
    | "idle"
    | "starting"
    | "qr"
    | "password"
    | "checking"
    | "connected"
    | "error";
  credentials: boolean;
  gatewayRunning: boolean;
  qrSvg: string | null;
  detail: string | null;
};

export interface TelegramRuntime {
  start(): Promise<void>;
  status(): Promise<TelegramConnection>;
  login(): Promise<TelegramConnection>;
  password(value: string): Promise<TelegramConnection>;
  cancel(): Promise<TelegramConnection>;
  markConnected(): void;
  close(): Promise<void>;
}

const authEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("qr"), svg: z.string().startsWith("<svg") }),
  z.looseObject({
    type: z.literal("password_required"),
    detail: z.string().max(500).optional(),
  }),
  z.looseObject({ type: z.literal("connected") }),
  z.looseObject({ type: z.literal("error"), detail: z.string().max(500) }),
]);

export class LocalTelegramRuntime implements TelegramRuntime {
  private gateway: ChildProcess | undefined;
  private authentication: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private connection: Omit<
    TelegramConnection,
    "credentials" | "gatewayRunning"
  > = {
    status: "idle",
    qrSvg: null,
    detail: null,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly connected: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async start(): Promise<void> {
    if (this.config.gatewayEnabled) {
      await this.startGateway();
    }
  }

  async status(): Promise<TelegramConnection> {
    return {
      ...this.connection,
      credentials: await this.credentialsPresent(),
      gatewayRunning: this.gateway !== undefined,
    };
  }

  async login(): Promise<TelegramConnection> {
    if (this.authentication) {
      return this.status();
    }
    const credentials = await telegramCredentials(runtimeRoot());
    await this.stopGateway();
    this.connection = {
      status: "starting",
      qrSvg: null,
      detail: "Подготавливаем безопасный вход. Не закрывайте эту страницу.",
    };
    const child = spawn(
      uvExecutable(),
      [
        "--directory",
        join(packageRoot, "vendor", "telegram-mcp"),
        "run",
        "--locked",
        "python",
        join(packageRoot, "etc", "login.py"),
        "--web",
      ],
      {
        cwd: packageRoot,
        env: telegramEnvironment(credentials, runtimeRoot()),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.authentication = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.acceptEvent(line);
    });
    child.once("error", () => {
      this.connection = {
        status: "error",
        qrSvg: null,
        detail: "Не удалось запустить локальный вход. Проверьте установку uv.",
      };
    });
    child.once("close", (code) => {
      void this.finishLogin(code);
    });
    return this.status();
  }

  async password(value: string): Promise<TelegramConnection> {
    const child = this.authentication;
    assert(child, "Вход не запущен. Нажмите «Авторизоваться» заново.");
    assert(
      this.connection.status === "password",
      "Telegram пока не запросил пароль двухфакторной аутентификации.",
    );
    this.connection = {
      status: "checking",
      qrSvg: null,
      detail: "Проверяем пароль. Он не сохраняется и не записывается в журнал.",
    };
    child.stdin.write(`${JSON.stringify({ type: "password", value })}\n`);
    return this.status();
  }

  async cancel(): Promise<TelegramConnection> {
    await this.stopAuthentication();
    this.connection = {
      status: "idle",
      qrSvg: null,
      detail: "Вход отменён. Существующая сессия не изменена.",
    };
    await this.startGateway();
    return this.status();
  }

  markConnected(): void {
    if (this.authentication || this.stopping) {
      return;
    }
    this.connection = { status: "connected", qrSvg: null, detail: null };
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all([this.stopAuthentication(), this.stopGateway()]);
  }

  private acceptEvent(line: string): void {
    const event = parseAuthEvent(line);
    if (!event) {
      return;
    }
    if (event.type === "qr") {
      this.connection = {
        status: "qr",
        qrSvg: event.svg,
        detail:
          "Отсканируйте QR в Telegram: Настройки → Устройства → Подключить устройство.",
      };
      return;
    }
    if (event.type === "password_required") {
      this.connection = {
        status: "password",
        qrSvg: null,
        detail:
          event.detail ??
          "Введите пароль двухфакторной аутентификации. Он используется только для этого входа.",
      };
      return;
    }
    if (event.type === "connected") {
      this.connection = {
        status: "connected",
        qrSvg: null,
        detail: "Telegram авторизован. Перезапускаем локальное подключение.",
      };
      return;
    }
    this.connection = { status: "error", qrSvg: null, detail: event.detail };
  }

  private async finishLogin(code: number | null): Promise<void> {
    this.authentication = undefined;
    if (this.stopping) {
      return;
    }
    if (code === 0 && this.connection.status === "connected") {
      try {
        await this.connected();
      } catch {
        this.connection.detail =
          "Telegram авторизован, но статус в Wiki не обновлён. Повторная установка исправит это.";
      }
    } else if (this.connection.status !== "error") {
      this.connection = {
        status: "error",
        qrSvg: null,
        detail: "Вход завершился без подтверждения. Попробуйте ещё раз.",
      };
    }
    await this.startGateway();
  }

  private async startGateway(): Promise<void> {
    if (
      !this.config.gatewayEnabled ||
      this.gateway ||
      this.authentication ||
      this.stopping
    ) {
      return;
    }
    let credentials;
    try {
      credentials = await telegramCredentials(runtimeRoot());
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      this.connection = {
        status: "idle",
        qrSvg: null,
        detail: "Добавьте API ID и API Hash, затем нажмите «Авторизоваться».",
      };
      return;
    }
    const child = spawn(
      uvExecutable(),
      [
        "--directory",
        join(packageRoot, "vendor", "telegram-mcp"),
        "run",
        "--locked",
        "main.py",
      ],
      {
        cwd: packageRoot,
        env: telegramEnvironment(credentials, runtimeRoot()),
        stdio: "ignore",
        windowsHide: true,
      },
    );
    this.gateway = child;
    child.once("error", (error: NodeJS.ErrnoException) => {
      console.error(
        "Не удалось запустить Telegram MCP:",
        error.code ?? error.name,
      );
      this.gateway = undefined;
      this.connection = {
        status: "error",
        qrSvg: null,
        detail: "Не удалось запустить Telegram MCP. Проверьте установку uv.",
      };
    });
    child.once("close", () => {
      if (this.gateway === child) {
        this.gateway = undefined;
      }
      if (
        !this.stopping &&
        !this.authentication &&
        this.connection.status === "connected"
      ) {
        this.connection = {
          status: "idle",
          qrSvg: null,
          detail:
            "Подключение остановлено. Обновите страницу или авторизуйтесь заново.",
        };
      }
    });
    const endpoint = new URL(this.config.telegramMcpUrl);
    const deadline = Date.now() + 8000;
    while (this.gateway === child && Date.now() < deadline) {
      if (await isListening(endpoint)) {
        return;
      }
      await setTimeout(150);
    }
  }

  private async stopGateway(): Promise<void> {
    const child = this.gateway;
    this.gateway = undefined;
    if (child) {
      await stopProcess(child);
    }
  }

  private async stopAuthentication(): Promise<void> {
    const child = this.authentication;
    this.authentication = undefined;
    if (child) {
      await stopProcess(child);
    }
  }

  private async credentialsPresent(): Promise<boolean> {
    try {
      await telegramCredentials(runtimeRoot());
      return true;
    } catch {
      return false;
    }
  }
}

function isListening(endpoint: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: endpoint.hostname,
      port: Number(endpoint.port || "80"),
      timeout: 250,
    });
    function finish(ready: boolean): void {
      socket.destroy();
      resolve(ready);
    }
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("timeout", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}

function parseAuthEvent(line: string) {
  try {
    const parsed = authEvent.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  if (process.platform === "win32" && child.pid) {
    // `uv` владеет Python-потомком: на Windows нужно завершить всё своё дерево, чтобы снять SessionLock.
    // eslint-disable-next-line n/no-sync
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    if (result.error) {
      child.kill();
    }
  } else {
    child.kill();
  }
  await closed;
}
