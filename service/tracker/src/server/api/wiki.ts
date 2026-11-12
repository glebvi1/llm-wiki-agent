import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import * as v from "valibot";

import { DaySchema, InstantSchema } from "#src/domain/model.ts";
import { isDay, weekStart } from "#src/domain/time.ts";
import {
  HttpError,
  requireAuth,
  wikiAuthorized,
} from "#src/server/auth/guard.ts";
import {
  confirmWeekPlan,
  weekPlan,
  wikiExport,
  wikiQuery,
  wikiTransaction,
} from "#src/server/wiki-db.ts";

const sequence = v.pipe(v.string(), v.regex(/^(0|[1-9]\d*)$/));
const weekSchema = v.pipe(
  DaySchema,
  v.check(isDay, "неверная дата"),
  v.check(
    (day) => weekStart(day) === day,
    "неделя должна начинаться в понедельник",
  ),
);
const params = v.object({ id: v.string() });
const entities: Record<string, string> = {
  tasks: "task",
  projects: "project",
  goals: "goal",
  sprints: "sprint",
  logs: "task_log",
  journal: "journal",
  recurrences: "recurrence",
  routines: "routine",
  "routine-checks": "routine_check",
};

/** Существующие CRUD-команды выполняются с теми же обработчиками и одним commit. */
export function registerWikiCommandHook(app: FastifyInstance): void {
  app.addHook("onRoute", function wrap(route) {
    const method = route.method;
    if (
      Array.isArray(method) ||
      !["POST", "PATCH", "DELETE", "PUT"].includes(method)
    ) {
      return;
    }
    const commandPath = new RegExp(
      "^/api/(tasks|projects|goals|sprints|logs|journal|recurrences|routines|" +
        "routine-checks|plans|context|owner)(/|$)",
    );
    if (!commandPath.test(route.url)) {
      return;
    }
    const original = route.handler;
    route.handler = async function command(req, reply) {
      if (!wikiAuthorized(req.headers.authorization)) {
        return original.call(this, req, reply);
      }
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 200) {
        throw new HttpError(400, "нужен Idempotency-Key длиной 8–200 символов");
      }
      const pathname = new URL(req.url, "http://tracker.local").pathname;
      let attachment: unknown;
      if (req.isMultipart()) {
        const part = await req.file();
        if (!part) {
          throw new HttpError(400, "файл не приложен");
        }
        const bytes = await part.toBuffer();
        attachment = [
          part.filename,
          part.mimetype,
          createHash("sha256").update(bytes).digest("hex"),
        ];
        req.file = function sameFile() {
          return Promise.resolve(part);
        };
      }
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            req.method,
            req.url,
            req.body,
            attachment,
            req.headers["if-match"],
          ]),
        )
        .digest("hex");
      let response: unknown;
      const send = reply.send.bind(reply);
      // FastifyReply — thenable: ожидание перехваченного ответа иначе ждало бы реальную отправку.
      const capturedReply = new Proxy(reply, {
        get(target, key, receiver) {
          const result: unknown =
            key === "then" ? undefined : Reflect.get(target, key, receiver);
          return result;
        },
      });
      await wikiTransaction(async function execute() {
        const saved = await wikiQuery<{
          fingerprint: string;
          response: unknown;
        }>("SELECT * FROM wiki_command WHERE key=$1", [key]);
        const previous = saved.rows.at(0);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new HttpError(
              409,
              "Idempotency-Key уже использован для другой команды",
            );
          }
          response = previous.response;
          return;
        }
        const match = /^\/api\/([\w-]+)\/([^/?]+)$/.exec(pathname);
        const entity = match?.[1] ? entities[match[1]] : undefined;
        if (
          ["PATCH", "DELETE", "PUT"].includes(req.method) &&
          entity &&
          match?.[2]
        ) {
          const revision = req.headers["if-match"];
          if (typeof revision !== "string") {
            throw new HttpError(428, "нужен If-Match из GET объекта");
          }
          const latest = await wikiQuery<{ revision: string }>(
            `SELECT COALESCE(MAX(sequence),0)::text revision
             FROM goal_report_entity_version WHERE entity=$1 AND entity_id=$2`,
            [entity, decodeURIComponent(match[2])],
          );
          if (revision !== `"${latest.rows.at(0)?.revision ?? "0"}"`) {
            throw new HttpError(412, "объект изменился; прочитайте его заново");
          }
        }
        if (["PATCH", "PUT", "DELETE"].includes(req.method) && !entity) {
          const context = /^\/api\/(?:owner\/)?context\/([^/]+)$/.exec(
            pathname,
          );
          const entityName = pathname.startsWith("/api/owner/")
            ? "owner_context"
            : "project_context";
          const revision = await revisionFor(entityName, context?.[1]);
          if (typeof req.headers["if-match"] !== "string") {
            throw new HttpError(428, "нужен If-Match из /api/wiki/revision");
          }
          if (req.headers["if-match"] !== revision) {
            throw new HttpError(412, "объект изменился; прочитайте его заново");
          }
        }
        if (pathname === "/api/plans/week/confirm") {
          const revision = await planRevision();
          if (typeof req.headers["if-match"] !== "string") {
            throw new HttpError(428, "нужен If-Match из GET плана");
          }
          if (req.headers["if-match"] !== revision) {
            throw new HttpError(
              412,
              "план или задачи изменились; перечитайте план",
            );
          }
        }
        reply.send = function capture(payload) {
          response = payload;
          return capturedReply;
        };
        try {
          await original.call(app, req, reply);
        } finally {
          reply.send = send;
        }
        await wikiQuery(
          "INSERT INTO wiki_command(key,fingerprint,response) VALUES($1,$2,$3)",
          [key, fingerprint, JSON.stringify(response)],
        );
      });
      return send(response);
    };
  });
}

export function registerWikiRoutes(app: FastifyInstance): void {
  app.get("/api/wiki/revision", async (req, reply) => {
    await requireAuth(req);
    const query = v.parse(
      v.object({
        entity: v.picklist(["project_context", "owner_context"]),
        id: v.optional(v.string()),
      }),
      req.query,
    );
    const result = await wikiTransaction(async function readContext() {
      const revision = await revisionFor(query.entity, query.id);
      const current = await wikiQuery<{ snapshot: unknown }>(
        `SELECT snapshot FROM (
        SELECT DISTINCT ON(entity_id) snapshot,action FROM goal_report_entity_version
        WHERE entity=$1 AND ($2::text IS NULL OR entity_id=$2)
        ORDER BY entity_id,sequence DESC) latest WHERE action<>'deleted'`,
        [query.entity, query.id ?? null],
      );
      reply.header("ETag", revision);
      return { revision, records: current.rows.map((row) => row.snapshot) };
    });
    return reply.send({ ok: true, result });
  });
  app.get("/api/wiki/export", async (req, reply) => {
    await requireAuth(req);
    const query = v.parse(
      v.object({
        after: v.optional(sequence, "0"),
        until: v.optional(sequence),
        capturedAt: v.optional(InstantSchema),
        limit: v.optional(v.pipe(v.string(), v.regex(/^\d+$/)), "500"),
      }),
      req.query,
    );
    const limit = Number(query.limit);
    if (limit < 1 || limit > 2000) {
      throw new HttpError(400, "limit должен быть от 1 до 2000");
    }
    return reply.send({
      ok: true,
      result: await wikiExport(
        query.after,
        query.until,
        limit,
        query.capturedAt,
      ),
    });
  });
  app.get("/api/plans/week/:week", async (req, reply) => {
    await requireAuth(req);
    const { week } = v.parse(v.object({ week: weekSchema }), req.params);
    const result = await wikiTransaction(async function readPlan() {
      reply.header("ETag", await planRevision());
      return weekPlan(week);
    });
    return reply.send({ ok: true, result });
  });
  app.post("/api/plans/week/confirm", async (req, reply) => {
    await requireAuth(req);
    const body = v.parse(
      v.object({ week: weekSchema, taskIds: v.array(v.string()) }),
      req.body,
    );
    return reply.send({
      ok: true,
      result: await confirmWeekPlan(body.week, body.taskIds),
    });
  });
  for (const [route, entity] of Object.entries(entities)) {
    if (route !== "routine-checks") {
      app.get(`/api/${route}/:id`, async (req, reply) => {
        await requireAuth(req);
        const { id } = v.parse(params, req.params);
        const result = await wikiTransaction(async function read() {
          const latest = await wikiQuery<{
            sequence: string;
            action: string;
            snapshot: unknown;
          }>(
            `SELECT version.sequence::text,action,snapshot FROM goal_report_entity_version version
           WHERE entity=$1 AND entity_id=$2 ORDER BY version.sequence DESC LIMIT 1`,
            [entity, id],
          );
          const row = latest.rows.at(0);
          if (!row || row.action === "deleted") {
            throw new HttpError(404, "объект не найден");
          }
          reply.header("ETag", `"${row.sequence}"`);
          return row.snapshot;
        });
        return reply.send({ ok: true, result });
      });
    }
    if (route === "journal") {
      continue;
    }
    app.get(`/api/${route}`, async (req, reply) => {
      await requireAuth(req);
      const { q } = v.parse(
        v.object({ q: v.optional(v.string(), "") }),
        req.query,
      );
      const latest = await wikiQuery<{ snapshot: unknown }>(
        `SELECT to_jsonb(t) snapshot FROM ${entity} t WHERE to_jsonb(t)::text ILIKE $1 ORDER BY id`,
        [`%${q}%`],
      );
      return reply.send({
        ok: true,
        result: latest.rows.map((row) => row.snapshot),
      });
    });
  }
}

async function planRevision(): Promise<string> {
  const latest = await wikiQuery<{ revision: string }>(
    `SELECT COALESCE(MAX(sequence),0)::text revision FROM goal_report_entity_version
     WHERE entity IN ('task','sprint','weekly_plan')`,
  );
  return `"${latest.rows.at(0)?.revision ?? "0"}"`;
}

async function revisionFor(
  entity: string,
  id: string | undefined,
): Promise<string> {
  const latest = await wikiQuery<{ revision: string }>(
    `SELECT COALESCE(MAX(sequence),0)::text revision
    FROM goal_report_entity_version WHERE entity=$1 AND ($2::text IS NULL OR entity_id=$2)`,
    [entity, id ?? null],
  );
  return `"${latest.rows.at(0)?.revision ?? "0"}"`;
}
