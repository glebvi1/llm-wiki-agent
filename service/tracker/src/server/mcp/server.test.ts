import { Client } from "@modelcontextprotocol/sdk/client";
// eslint-disable-next-line import-x/no-unresolved, n/no-missing-import -- ошибка wildcard types-export SDK
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi, assert } from "vitest";

import { trackerTools } from "./catalog.ts";
import { registerTrackerMcp } from "./server.ts";

const token = "test-tracker-mcp-token-with-at-least-32-characters";
vi.mock(import("#src/server/config.ts"), () => ({
  config: {
    wikiApiToken: "test-tracker-mcp-token-with-at-least-32-characters",
  } as never,
}));
const closers: (() => Promise<unknown>)[] = [];

async function harness() {
  const app = Fastify();
  registerTrackerMcp(app);
  const requests: {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, unknown>;
  }[] = [];
  app.all("/api/*", (req, reply) => {
    requests.push({
      url: req.url,
      method: req.method,
      body: req.body,
      headers: req.headers,
    });
    if (req.method === "GET") {
      if (req.url === "/api/tasks") {
        return reply.send({
          ok: true,
          result: [
            { id: "1", project_id: "p", status: "doing" },
            { id: "2", project_id: "q", status: "done" },
          ],
        });
      }
      return reply
        .header("ETag", '"7"')
        .send({ ok: true, result: { id: "1", title: "текущее состояние" } });
    }
    if (req.headers["if-match"] === '"6"') {
      return reply.code(412).send({ ok: false, detail: "объект изменился" });
    }
    return reply.send({ ok: true, result: { id: "1" } });
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const client = new Client({ name: "tracker-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  closers.push(() => client.close());
  return { app, client, requests };
}

describe(registerTrackerMcp, () => {
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close();
    }
  });

  it("принимает файл 20 МБ без переполнения стека и требует один способ передачи", () => {
    const tool = trackerTools.find((item) => item.name === "upload_owner_file");
    assert(tool);
    const args = { operationId: "large-file-test", filename: "large.txt" };
    const contentBase64 = Buffer.alloc(20 * 1024 * 1024, 65).toString("base64");
    expect(tool.schema.safeParse({ ...args, contentBase64 }).success).toBe(
      true,
    );
    expect(
      tool.schema.safeParse({ ...args, contentText: "полный текст" }).success,
    ).toBe(true);
    expect(tool.schema.safeParse(args).success).toBe(false);
    expect(
      tool.schema.safeParse({ ...args, contentBase64: "bad!" }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ ...args, contentBase64, contentText: "текст" })
        .success,
    ).toBe(false);
  });

  it("настоящий MCP-клиент подключается и видит полный каталог команд", async () => {
    const { client } = await harness();
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toStrictEqual(
      trackerTools.map((tool) => tool.name),
    );
    expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(
      trackerTools.length,
    );
    expect(catalog.tools.length).toBeGreaterThan(45);
    const snapshot = await client.callTool({
      name: "get_snapshot",
      arguments: {},
    });
    expect(snapshot.isError).toBe(false);
  });

  it("не пускает без токена, по cookie, с неверным токеном и чужим Origin", async () => {
    const { app } = await harness();
    for (const headers of [
      {},
      { cookie: "tracker_session=anything" },
      { authorization: "Bearer wrong" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
    const foreign = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
      payload: {},
    });
    expect(foreign.statusCode).toBe(403);
    const get = await app.inject({
      method: "GET",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(405);
  });

  it("отклоняет неверные поля и даты до обращения к API", async () => {
    const { client, requests } = await harness();
    const invalid = await client.callTool({
      name: "update_task",
      arguments: {
        id: "1",
        operationId: "operation-1",
        version: '"7"',
        plannedFor: "2026-02-30",
      },
    });
    expect(invalid.isError).toBe(true);
    const unknown = await client.callTool({
      name: "create_task",
      arguments: {
        projectId: "p",
        title: "тест",
        operationId: "operation-1",
        injectedField: "no",
      },
    });
    expect(unknown.isError).toBe(true);
    expect(requests).toStrictEqual([]);
  });

  it("передаёт постоянный ключ и прочитанную версию, различает null и отсутствие поля", async () => {
    const { client, requests } = await harness();
    const args = {
      id: "1",
      operationId: "operation-1",
      version: '"7"',
      plannedFor: null,
    };
    const changed = await client.callTool({
      name: "update_task",
      arguments: args,
    });
    expect(changed.isError).toBe(false);
    expect(requests[0]?.headers["idempotency-key"]).toBe("mcp:operation-1");
    expect(requests[0]?.headers["if-match"]).toBe('"7"');
    expect(requests[0]?.body).toStrictEqual({ plannedFor: null });
    expect(requests[1]?.method).toBe("GET");
    await client.callTool({ name: "update_task", arguments: args });
    expect(requests[2]?.headers["idempotency-key"]).toBe(
      requests[0]?.headers["idempotency-key"],
    );
    expect(requests[2]?.body).toStrictEqual(requests[0]?.body);
  });

  it("возвращает конфликт и не подменяет версию автоматически", async () => {
    const { client, requests } = await harness();
    const changed = await client.callTool({
      name: "update_task",
      arguments: {
        id: "1",
        operationId: "operation-1",
        version: '"6"',
        title: "правка",
      },
    });
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent).toMatchObject({ status: 412 });
    expect(requests).toHaveLength(1);
  });

  it("передаёт явный перенос недели и снятие дат одним PATCH", async () => {
    const { client, requests } = await harness();
    const changed = await client.callTool({
      name: "update_task",
      arguments: {
        id: "1",
        operationId: "week-move-1",
        version: '"7"',
        plannedWeek: "2026-11-09",
        plannedFor: null,
        eventOn: null,
      },
    });
    expect(changed.isError).toBe(false);
    expect(requests[0]?.body).toStrictEqual({
      plannedWeek: "2026-11-09",
      plannedFor: null,
      eventOn: null,
    });
    expect(requests[0]?.headers["if-match"]).toBe('"7"');
  });

  it("фильтрует и выдаёт списки порциями, не скрывая продолжение", async () => {
    const { client } = await harness();
    const page = await client.callTool({
      name: "list_tasks",
      arguments: { limit: 1 },
    });
    expect(page.structuredContent).toMatchObject({
      result: { total: 2, nextOffset: 1, items: [{ id: "1" }] },
    });
    const filtered = await client.callTool({
      name: "list_tasks",
      arguments: { projectId: "q", status: "done" },
    });
    expect(filtered.structuredContent).toMatchObject({
      result: { total: 1, nextOffset: null, items: [{ id: "2" }] },
    });
  });

  it("кодирует id как сегмент пути и сохраняет query экспорта", async () => {
    const { client, requests } = await harness();
    await client.callTool({ name: "get_task", arguments: { id: "a/b?c" } });
    expect(requests[0]?.url).toBe("/api/tasks/a%2Fb%3Fc");
    await client.callTool({
      name: "export_history",
      arguments: {
        after: "7",
        until: "9",
        capturedAt: "2026-10-26T00:00:00Z",
        limit: 1,
      },
    });
    const request = requests.at(-1);
    assert(request);
    const query = new URL(request.url, "http://tracker.local").searchParams;
    expect(query.get("after")).toBe("7");
    expect(query.get("until")).toBe("9");
    expect(query.get("capturedAt")).toBe("2026-10-26T00:00:00Z");
  });
});
