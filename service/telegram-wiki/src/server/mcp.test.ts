import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client";
// eslint-disable-next-line import-x/no-unresolved, n/no-missing-import -- ошибка wildcard types-export SDK
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";
import * as z from "zod/v4";

import type { AppConfig } from "#src/server/config.ts";
import { buildServer, dependencies } from "#src/server/server.ts";
import {
  FakeTelegramGateway,
  testMessage,
} from "#src/server/test/fake-gateway.ts";

let root: string;
let app: FastifyInstance;
let client: Client | undefined;
let gateway: FakeTelegramGateway;
let store: ReturnType<typeof dependencies>["store"];
let endpoint: string;
const token = "test-only-telegram-wiki-token-32-characters";

describe("интеграция MCP", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-mcp-"));
    gateway = new FakeTelegramGateway();
    const config: AppConfig = {
      wikiRoot: root,
      token,
      telegramMcpUrl: "http://127.0.0.1:8765/mcp",
      codexPath: "codex",
      port: 0,
      syncIntervalMs: 60_000,
      enableSync: false,
      gatewayEnabled: false,
    };
    const deps = dependencies(config, gateway, {
      run: () => Promise.resolve(),
    });
    store = deps.store;
    app = await buildServer(deps);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert(address && typeof address === "object");
    endpoint = `http://127.0.0.1:${String(address.port)}/api/mcp`;
    client = new Client({ name: "telegram-wiki-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterEach(async () => {
    await client?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  describe("протокол MCP", () => {
    it("открывает только узкий набор инструментов и требует Bearer", async () => {
      assert(client);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toStrictEqual([
        "get_drafts",
        "get_message_context",
        "ingest_begin",
        "ingest_finish",
        "ingest_status",
        "list_chats",
        "prepare_send",
        "read_messages",
        "save_draft",
        "send_prepared",
      ]);

      const unauthorized = new Client({
        name: "unauthorized-test",
        version: "1.0.0",
      });
      await expect(
        unauthorized.connect(
          new StreamableHTTPClientTransport(new URL(endpoint)),
        ),
      ).rejects.toThrow("нужен локальный токен Telegram Wiki");
    });

    it("читает выключенный чат по московской дате без импорта и файлов Wiki", async () => {
      assert(client);
      gateway.setMessages("42", [
        testMessage(1, "Вчера по Москве", "2026-11-09T20:59:59.999Z"),
        testMessage(2, "Нужное решение", "2026-11-09T21:00:00.000Z"),
        testMessage(3, "Уже завтра", "2026-11-10T21:00:00.000Z"),
      ]);
      const response = await client.callTool({
        name: "read_messages",
        arguments: {
          chatId: "42",
          from: "2026-11-10",
          to: "2026-11-10",
          limit: 50,
        },
      });
      const result = toolResult(response);
      const parsed = z
        .object({
          source: z.object({
            live: z.literal(true),
            importChanged: z.literal(false),
          }),
          messages: z.array(z.object({ id: z.number(), text: z.string() })),
        })
        .parse(result);
      expect(parsed.messages).toStrictEqual([
        { id: 2, text: "Нужное решение" },
      ]);
      expect((await store.read()).chats).toStrictEqual({});
      await expect(
        readdir(join(root, "Исходники", "Telegram")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("находит личный диалог по @username независимо от названия", async () => {
      assert(client);
      gateway.chats = [
        { id: "42", title: "Личный чат", type: "private", username: "Example" },
      ];
      const response = await client.callTool({
        name: "list_chats",
        arguments: { q: "@example" },
      });
      expect(toolResult(response)).toStrictEqual({
        chats: [{ ...gateway.chats[0], importEnabled: false }],
        count: 1,
      });
      expect((await store.read()).chats).toStrictEqual({});
    });

    it("показывает конфликт черновика и ничего не сохраняет", async () => {
      assert(client);
      gateway.draftRows = [
        { chatId: "42", text: "Существующий", date: null, replyTo: null },
      ];
      const response = await client.callTool({
        name: "save_draft",
        arguments: {
          chatId: "42",
          text: "Новый",
          existingDraft: null,
          replaceExisting: false,
        },
      });
      expect(response.isError).toBe(true);
      expect(gateway.draftRows).toStrictEqual([
        { chatId: "42", text: "Существующий", date: null, replyTo: null },
      ]);
    });
  });
});

function toolResult(response: unknown): unknown {
  const content = z
    .object({
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .parse(response);
  const text = content.content.find((item) => item.type === "text")?.text;
  assert(text);
  return z
    .object({ ok: z.boolean(), result: z.unknown() })
    .parse(JSON.parse(text)).result;
}
