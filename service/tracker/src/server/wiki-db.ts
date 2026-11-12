import type pg from "pg";

import type { Day, Task } from "#src/domain/model.ts";
import { weekStart } from "#src/domain/time.ts";
import { HttpError } from "#src/server/auth/guard.ts";
import { store, wikiClient, wikiPool } from "#src/server/db.ts";

const entities = [
  "project",
  "goal",
  "sprint",
  "task",
  "task_log",
  "journal",
  "project_context",
  "owner_context",
  "recurrence",
  "routine",
  "routine_check",
  "goal_link",
  "goal_link_decision",
  "weekly_plan",
  "contact",
  "report",
];

export async function initWikiDb(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS wiki_command (
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weekly_plan (
      id TEXT PRIMARY KEY, confirmed_at TEXT NOT NULL, initial JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_audit_coverage (entity TEXT PRIMARY KEY, started_at TEXT NOT NULL);
    CREATE OR REPLACE FUNCTION wiki_writer_lock() RETURNS TRIGGER AS $lock$
    BEGIN PERFORM pg_advisory_xact_lock(771204312); RETURN NULL; END
    $lock$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION wiki_extra_audit() RETURNS TRIGGER AS $audit$
    DECLARE body JSONB;
    BEGIN
      IF TG_OP='DELETE' THEN body:=to_jsonb(OLD); ELSE body:=to_jsonb(NEW); END IF;
      INSERT INTO goal_report_entity_version(entity,entity_id,recorded_at,action,snapshot)
      VALUES(TG_TABLE_NAME,COALESCE(body->>'id',body->>'sequence'),goal_report_audit_timestamp(),
        CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE 'present' END,body);
      RETURN NULL;
    END
    $audit$ LANGUAGE plpgsql;
  `);
  for (const entity of entities) {
    const legacy = [
      "project",
      "goal",
      "sprint",
      "task",
      "task_log",
      "journal",
      "project_context",
      "owner_context",
    ].includes(entity);
    const startedAt = legacy
      ? "(SELECT started_at FROM goal_report_audit_meta)"
      : "goal_report_audit_timestamp()";
    await client.query(`
      DROP TRIGGER IF EXISTS wiki_writer_lock ON ${entity};
      CREATE TRIGGER wiki_writer_lock BEFORE INSERT OR UPDATE OR DELETE ON ${entity}
      FOR EACH STATEMENT EXECUTE FUNCTION wiki_writer_lock();
      INSERT INTO wiki_audit_coverage VALUES('${entity}',${startedAt}) ON CONFLICT DO NOTHING;
    `);
    if (
      [
        "recurrence",
        "routine",
        "routine_check",
        "goal_link",
        "goal_link_decision",
        "weekly_plan",
        "contact",
        "report",
      ].includes(entity)
    ) {
      await client.query(`
        DROP TRIGGER IF EXISTS wiki_extra_audit ON ${entity};
        CREATE TRIGGER wiki_extra_audit AFTER INSERT OR UPDATE OR DELETE ON ${entity}
        FOR EACH ROW EXECUTE FUNCTION wiki_extra_audit();
        INSERT INTO goal_report_entity_version(entity,entity_id,recorded_at,action,snapshot)
        SELECT '${entity}',COALESCE(to_jsonb(t)->>'id',to_jsonb(t)->>'sequence'),
          goal_report_audit_timestamp(),'present',to_jsonb(t) FROM ${entity} t
        WHERE NOT EXISTS(SELECT 1 FROM goal_report_entity_version v WHERE v.entity='${entity}'
          AND v.entity_id=COALESCE(to_jsonb(t)->>'id',to_jsonb(t)->>'sequence'));
      `);
    }
  }
}

export async function wikiTransaction<T>(action: () => Promise<T>): Promise<T> {
  if (wikiClient.getStore()) {
    return action();
  }
  const client = await wikiPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(771204312)");
    const result = await wikiClient.run(client, action);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function wikiQuery<T extends pg.QueryResultRow>(
  sql: string,
  args?: unknown[],
) {
  return (wikiClient.getStore() ?? wikiPool).query<T>(sql, args);
}

export async function wikiExport(
  after: string,
  until: string | undefined,
  limit: number,
  capturedAt: string | undefined,
) {
  return wikiTransaction(async function capture() {
    const maximum = await wikiQuery<{ maximum: string }>(
      "SELECT COALESCE(MAX(sequence),0)::text maximum FROM goal_report_entity_version",
    );
    const upper = until ?? maximum.rows.at(0)?.maximum ?? "0";
    if (
      BigInt(upper) > BigInt(maximum.rows.at(0)?.maximum ?? "0") ||
      BigInt(after) > BigInt(upper)
    ) {
      throw new HttpError(400, "неверная граница выгрузки");
    }
    const { rows } = await wikiQuery<{
      sequence: string;
      entityType: string;
      entityId: string;
      operation: string;
      recordedAt: string;
      payload: unknown;
    }>(
      `SELECT version.sequence::text,entity "entityType",entity_id "entityId",action operation,
        recorded_at "recordedAt",snapshot payload FROM goal_report_entity_version version
        WHERE version.sequence>$1 AND version.sequence<=$2 ORDER BY version.sequence LIMIT $3`,
      [after, upper, limit + 1],
    );
    const complete = rows.length <= limit;
    const changes = rows.slice(0, limit);
    const meta = await wikiQuery<{ started_at: string }>(
      "SELECT started_at FROM goal_report_audit_meta",
    );
    const coverage = await wikiQuery<{ entity: string; started_at: string }>(
      "SELECT * FROM wiki_audit_coverage ORDER BY entity",
    );
    const snapshot: Record<string, unknown[]> = {};
    if (after === "0") {
      for (const entity of entities) {
        const current = await wikiQuery<{ snapshot: unknown }>(
          `SELECT snapshot FROM (SELECT DISTINCT ON(entity_id) snapshot,action FROM goal_report_entity_version
            WHERE entity=$1 AND sequence<=$2 ORDER BY entity_id,sequence DESC) latest WHERE action<>'deleted'`,
          [entity, upper],
        );
        snapshot[entity] = current.rows.map((row) => row.snapshot);
      }
    }
    return {
      schemaVersion: 1,
      historyStartedAt: meta.rows.at(0)?.started_at ?? null,
      historyCoverage: Object.fromEntries(
        coverage.rows.map((row) => [row.entity, row.started_at]),
      ),
      capturedAt: capturedAt ?? new Date().toISOString(),
      until: upper,
      cursor: complete ? upper : (changes.at(-1)?.sequence ?? after),
      complete,
      changes,
      ...(after === "0" ? { snapshot } : {}),
    };
  });
}

export async function weekPlan(week: Day) {
  const { rows } = await wikiQuery<{ confirmed_at: string; initial: Task[] }>(
    "SELECT * FROM weekly_plan WHERE id=$1",
    [week],
  );
  const current = (await store.tasks()).filter((t) => t.plannedWeek === week);
  return {
    week,
    confirmedAt: rows.at(0)?.confirmed_at ?? null,
    initial: rows.at(0)?.initial ?? null,
    current,
  };
}

export async function confirmWeekPlan(week: Day, taskIds: string[]) {
  if (weekStart(week) !== week) {
    throw new HttpError(400, "неделя должна начинаться в понедельник");
  }
  return wikiTransaction(async function confirm() {
    const chosen = new Set(taskIds);
    const tasks = await store.tasks();
    if (taskIds.some((id) => !tasks.some((t) => t.id === id))) {
      throw new HttpError(404, "задача не найдена");
    }
    const before = await weekPlan(week);
    for (const task of before.current) {
      if (
        !chosen.has(task.id) &&
        (task.status === "backlog" || task.status === "doing")
      ) {
        if (task.plannedFor !== null || task.eventOn !== null) {
          throw new HttpError(
            400,
            "задача с датой остаётся в своей неделе — явно снимите дату перед исключением из плана",
          );
        }
        await store.updateTask(task.id, { plannedWeek: null });
      }
    }
    for (const task of tasks.filter((t) => chosen.has(t.id))) {
      if (task.status !== "backlog" && task.status !== "doing") {
        continue;
      }
      if (before.current.some((t) => t.id === task.id)) {
        continue;
      }
      await store.updateTask(task.id, { plannedWeek: week });
    }
    const current = await weekPlan(week);
    await wikiQuery(
      "INSERT INTO weekly_plan(id,confirmed_at,initial) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [week, new Date().toISOString(), JSON.stringify(current.current)],
    );
    return weekPlan(week);
  });
}
