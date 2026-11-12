import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { onlyForTesting as runner } from "./wiki-sync-run.ts";
import { onlyForTesting as installer } from "./wiki-sync-schedule.ts";

const { deliver } = runner;
const { installationPlan } = installer;

describe(deliver, () => {
  it("сохраняет успех и безопасный отказ без утечки ошибки процесса", async () => {
    const folder = await mkdtemp(join(tmpdir(), "wiki-schedule-"));
    try {
      const config = join(folder, "settings.json");
      await expect(
        deliver(config, () => Promise.resolve("получено\n")),
      ).resolves.toBe(true);
      expect(
        JSON.parse(
          await readFile(join(folder, "schedule-status.json"), "utf8"),
        ),
      ).toMatchObject({ success: true });
      await expect(
        deliver(config, () => Promise.reject(new Error("secret-token"))),
      ).resolves.toBe(false);
      expect(
        JSON.parse(
          await readFile(join(folder, "schedule-status.json"), "utf8"),
        ),
      ).toMatchObject({ success: false });
      await expect(
        readFile(join(folder, "last-run.log"), "utf8"),
      ).resolves.not.toContain("secret-token");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe(installationPlan, () => {
  it("назначает отдельные запуски Windows, скрывает окно и не запускает daemon", () => {
    const plan = installationPlan(
      "C:\\my\\node.exe",
      "C:\\my\\a b\\run.ts",
      "C:\\my\\settings.json",
      "C:\\my\\run.vbs",
      "C:\\my",
      "C:\\Windows",
    );
    expect(plan.install).toContain("New-TimeSpan -Minutes 15");
    expect(plan.install).toContain("-StartWhenAvailable");
    expect(plan.install).toContain("-AtLogOn");
    expect(plan.install).toContain("-MultipleInstances IgnoreNew");
    expect(plan.install).not.toContain("wiki-sync-daemon");
    expect(plan.launcher).toContain('""C:\\my\\a b\\run.ts""');
    expect(plan.launcher).toContain(", 0, True)");
  });
});
