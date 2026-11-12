import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import * as z from "zod/v4";

import { chatComment, day } from "#src/model.ts";
import { CodexWikiRunner } from "#src/server/codex.ts";
import type { AppConfig } from "#src/server/config.ts";
import {
  McpTelegramGateway,
  type TelegramGateway,
} from "#src/server/gateway.ts";
import { TelegramImporter } from "#src/server/importer.ts";
import { registerTelegramMcp } from "#src/server/mcp.ts";
import { TelegramOperations } from "#src/server/operations.ts";
import { WikiProcessing } from "#src/server/processing.ts";
import { WikiStore } from "#src/server/store.ts";
import { SyncCoordinator, type WikiRunner } from "#src/server/sync.ts";
import {
  LocalTelegramRuntime,
  type TelegramRuntime,
} from "#src/server/telegram-runtime.ts";

export interface AppDependencies {
  config: AppConfig;
  gateway: TelegramGateway;
  store: WikiStore;
  importer: TelegramImporter;
  operations: TelegramOperations;
  processing: WikiProcessing;
  sync: SyncCoordinator;
  runtime: TelegramRuntime;
}

export function dependencies(
  config: AppConfig,
  gateway?: TelegramGateway,
  runner?: WikiRunner,
  runtime?: TelegramRuntime,
): AppDependencies {
  const actualGateway =
    gateway ?? new McpTelegramGateway(config.telegramMcpUrl);
  const store = new WikiStore(config.wikiRoot);
  const importer = new TelegramImporter(store, actualGateway);
  const actualRunner =
    runner ?? new CodexWikiRunner(config.codexPath, config.wikiRoot);
  return {
    config,
    gateway: actualGateway,
    store,
    importer,
    operations: new TelegramOperations(store, actualGateway),
    processing: new WikiProcessing(store),
    sync: new SyncCoordinator(importer, actualRunner),
    runtime: runtime ?? new LocalTelegramRuntime(config),
  };
}

export async function buildServer(
  deps: AppDependencies,
  staticRoot?: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const { config, store, importer, operations, processing } = deps;
  app.addHook("onRequest", async (req, reply) => {
    assertLocalRequest(req.headers.host, req.headers.origin);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ ok: false, detail: "некорректные параметры запроса" });
    }
    if (error instanceof assert.AssertionError) {
      return reply.code(400).send({ ok: false, detail: error.message });
    }
    console.error("необработанная ошибка Telegram Wiki");
    return reply.code(500).send({ ok: false, detail: "внутренняя ошибка" });
  });

  app.get("/api/health", () => ({
    ok: true,
    result: { service: "telegram-wiki", syncEnabled: config.enableSync },
  }));
  app.get("/api/telegram/status", async () => ({
    ok: true,
    result: await deps.runtime.status(),
  }));
  app.post("/api/telegram/login", async () => ({
    ok: true,
    result: await deps.runtime.login(),
  }));
  app.post("/api/telegram/password", async (req) => {
    const body = z
      .object({ password: z.string().min(1).max(1024) })
      .parse(req.body);
    return { ok: true, result: await deps.runtime.password(body.password) };
  });
  app.post("/api/telegram/cancel", async () => ({
    ok: true,
    result: await deps.runtime.cancel(),
  }));
  app.get("/api/chats", async () => {
    const chats = await importer.refreshChats();
    const state = await store.read();
    deps.runtime.markConnected();
    const result = chats.map((chat) => ({
      ...chat,
      settings: state.chats[chat.id] ?? null,
    }));
    return { ok: true, result };
  });
  app.put("/api/chats/:id", async (req) => {
    const params = z
      .object({ id: z.string().regex(/^-?\d+$/) })
      .parse(req.params);
    const body = z
      .object({
        enabled: z.boolean(),
        importFrom: z.enum(["now", "date", "all"]),
        fromDate: day.nullable().default(null),
        comment: chatComment.optional(),
      })
      .parse(req.body);
    assert(
      body.importFrom !== "date" || body.fromDate !== null,
      "укажите дату начала импорта",
    );
    const chats = await importer.refreshChats();
    const chat = chats.find((item) => item.id === params.id);
    assert(chat, "чат недоступен аккаунту");
    const result = await importer.configure(
      chat,
      body.enabled,
      body.importFrom,
      body.fromDate,
      body.comment,
    );
    return { ok: true, result };
  });
  app.patch("/api/chats/:id", async (req) => {
    const { id } = z
      .object({ id: z.string().regex(/^-?\d+$/) })
      .parse(req.params);
    const body = z
      .union([
        z.strictObject({ comment: chatComment }),
        z.strictObject({ enabled: z.literal(false) }),
      ])
      .parse(req.body);
    const state = await store.update((current) => {
      const chat = current.chats[id];
      assert(chat, "настройки чата не найдены");
      Object.assign(chat, body);
    });
    return { ok: true, result: state.chats[id] };
  });
  app.post("/api/sync", () => {
    void deps.sync.run().catch(() => {
      console.error("фоновое обновление Telegram Wiki завершилось ошибкой");
    });
    return { ok: true, result: { started: true, processingQueued: true } };
  });
  app.post("/api/chats/:id/delete-preview", async (req) => {
    const params = z
      .object({ id: z.string().regex(/^-?\d+$/) })
      .parse(req.params);
    return { ok: true, result: await importer.previewDeletion(params.id) };
  });
  app.delete("/api/chats/:id/sources", async (req) => {
    const params = z
      .object({ id: z.string().regex(/^-?\d+$/) })
      .parse(req.params);
    z.object({ confirmation: z.literal("УДАЛИТЬ") }).parse(req.body);
    await importer.deleteSources(params.id);
    return { ok: true, result: { deleted: true } };
  });
  app.get("/api/processing", async () => ({
    ok: true,
    result: await processing.status(),
  }));

  registerTelegramMcp(app, {
    store,
    importer,
    operations,
    processing,
    token: config.token,
  });
  if (staticRoot) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      index: ["index.html"],
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ ok: false, detail: "неизвестный API" });
      }
      return reply.sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => {
    await Promise.all([
      deps.runtime.close(),
      deps.gateway instanceof McpTelegramGateway
        ? deps.gateway.close()
        : Promise.resolve(),
    ]);
  });
  return app;
}

export async function startServer(
  deps: AppDependencies,
): Promise<FastifyInstance> {
  const staticRoot = fileURLToPath(new URL("../../dist", import.meta.url));
  const app = await buildServer(deps, staticRoot);
  await app.listen({ host: "127.0.0.1", port: deps.config.port });
  return app;
}

export function assertLocalRequest(
  host: string | undefined,
  origin: string | undefined,
): void {
  assert(host, "отсутствует Host");
  const hostname = new URL(`http://${host}`).hostname;
  assert(isLocal(hostname), "недопустимый Host");
  if (origin) {
    assert(isLocal(new URL(origin).hostname), "недопустимый Origin");
  }
}

function isLocal(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
