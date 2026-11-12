import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  assert,
} from "vitest";

import type { AppConfig } from "#src/server/config.ts";
import { buildServer, dependencies } from "#src/server/server.ts";
import { FakeTelegramGateway } from "#src/server/test/fake-gateway.ts";

let root: string;
let app: FastifyInstance | undefined;

describe("граница HTTP", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-http-"));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(root, { recursive: true, force: true });
  });

  describe("локальная HTTP граница", () => {
    it("отклоняет чужой Host, Origin и токен MCP", async () => {
      const deps = testDependencies(root);
      app = await buildServer(deps);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/health",
            headers: { host: "evil.example" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/health",
            headers: { host: "127.0.0.1:7100", origin: "https://evil.example" },
          })
        ).statusCode,
      ).toBe(400);
      const mcp = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          host: "127.0.0.1:7100",
          authorization: "Bearer wrong",
          contentType: "application/json",
        },
        payload: {},
      });
      expect(mcp.statusCode).toBe(401);
    });

    it("кнопка обновления ставит получение и обработку в одну очередь", async () => {
      const events: string[] = [];
      const deps = testDependencies(root);
      vi.spyOn(deps.importer, "syncAll").mockImplementation(() => {
        events.push("import");
        return Promise.resolve();
      });
      const runner = {
        run: vi.fn<() => Promise<void>>(() => {
          events.push("process");
          return Promise.resolve();
        }),
      };
      const withRunner = {
        ...deps,
        sync: new (await import("#src/server/sync.ts")).SyncCoordinator(
          deps.importer,
          runner,
        ),
      };
      app = await buildServer(withRunner);
      const response = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: { host: "localhost:7100" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({
        ok: true,
        result: { started: true, processingQueued: true },
      });
      await vi.waitFor(() => {
        expect(events).toStrictEqual(["import", "process"]);
      });
    });
  });
});

function testDependencies(wikiRoot: string) {
  const config: AppConfig = {
    wikiRoot,
    token: "test-only-telegram-wiki-token-32-characters",
    telegramMcpUrl: "http://127.0.0.1:8765/mcp",
    codexPath: "codex",
    port: 7100,
    syncIntervalMs: 60_000,
    enableSync: false,
    gatewayEnabled: false,
  };
  const deps = dependencies(config, new FakeTelegramGateway(), {
    run: () => Promise.resolve(),
  });
  assert(deps);
  return deps;
}
