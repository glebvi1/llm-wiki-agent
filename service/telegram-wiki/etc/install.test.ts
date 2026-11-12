import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";

import { installWiki } from "./install.ts";

let root: string;
let wikiRoot: string;
let appDataRoot: string;
let codexHome: string;

describe("установщик", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-wiki-install-"));
    wikiRoot = join(root, "LLM Wiki");
    appDataRoot = join(root, "AppData");
    codexHome = join(root, "CodexHome");
    await mkdir(wikiRoot, { recursive: true });
    await write("AGENTS.md", "# Моя Wiki\n\nПользовательский текст.\n");
    await write(
      "Правила LLM Wiki.md",
      [
        "# Правила",
        "",
        [
          "- [ ] **Подключить Telegram.** Сделать удобный способ работать с вики",
          "из Telegram. Как именно — решим, когда займёмся подключением.",
        ].join(" "),
        "Telegram пока остаётся задачей на будущее; без отдельного поручения его не настраиваем.",
        "",
        "## Как работать с источниками",
        "",
      ].join("\n"),
    );
    await write(
      ".agents/skills/wiki-telegram-ingest/approval.json",
      '{"status":"approved","approvedBundleSha256":"manual"}\n',
    );
    await write(
      ".codex/config.toml",
      '[mcp_servers.other]\nurl = "http://127.0.0.1:9999/mcp"\n',
    );
    await mkdir(
      dirname(join(codexHome, "automations", "tracker", "automation.toml")),
      { recursive: true },
    );
    await writeFile(
      join(codexHome, "automations", "tracker", "automation.toml"),
      'id = "tracker"\n',
      "utf8",
    );
    await mkdir(appDataRoot, { recursive: true });
    await writeFile(
      join(appDataRoot, "telegram-wiki.json"),
      JSON.stringify({
        wikiRoot,
        token: "existing-local-token-that-must-stay-unchanged",
        telegramMcpUrl: "http://127.0.0.1:8765/mcp",
        codexPath: "old-codex",
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("установка в существующую Wiki", () => {
    it("сохраняет чужие настройки, approval и токен, создаёт backup и отдельное расписание", async () => {
      const options = {
        wikiRoot,
        appDataRoot,
        codexHome,
        codexPath: "codex-test",
        nodePath: "node-test",
        projectId: "project-test",
      };
      const first = await installWiki(options);
      const agentsOnce = await readFile(join(wikiRoot, "AGENTS.md"), "utf8");
      const rulesOnce = await readFile(
        join(wikiRoot, "Правила LLM Wiki.md"),
        "utf8",
      );
      const configOnce = await readFile(
        join(wikiRoot, ".codex", "config.toml"),
        "utf8",
      );
      await installWiki(options);

      await expect(readFile(join(wikiRoot, "AGENTS.md"), "utf8")).resolves.toBe(
        agentsOnce,
      );
      expect(agentsOnce).toContain("Пользовательский текст.");
      expect(agentsOnce).toContain("wiki-telegram-ingest/SKILL.md");
      await expect(
        readFile(join(wikiRoot, "Правила LLM Wiki.md"), "utf8"),
      ).resolves.toBe(rulesOnce);
      await expect(
        readFile(
          join(
            wikiRoot,
            ".agents",
            "skills",
            "wiki-telegram-ingest",
            "approval.json",
          ),
          "utf8",
        ),
      ).resolves.toBe(
        '{"status":"approved","approvedBundleSha256":"manual"}\n',
      );
      await expect(
        readFile(join(wikiRoot, ".codex", "config.toml"), "utf8"),
      ).resolves.toBe(configOnce);
      expect(configOnce).toContain("[mcp_servers.other]");
      expect(configOnce.match(/\[mcp_servers\.telegram\]/g)).toHaveLength(1);

      const config = z
        .object({ token: z.string(), codexPath: z.string() })
        .parse(JSON.parse(await readFile(first.configPath, "utf8")));
      expect(config.token).toBe(
        "existing-local-token-that-must-stay-unchanged",
      );
      expect(config.codexPath).toBe("codex-test");
      const automation = await readFile(first.automationPath, "utf8");
      expect(automation).toContain('id = "telegram-wiki"');
      expect(automation).toContain("BYHOUR=9;BYMINUTE=0");
      expect(automation).toContain('project_id = "project-test"');
      await expect(
        readFile(
          join(codexHome, "automations", "tracker", "automation.toml"),
          "utf8",
        ),
      ).resolves.toBe('id = "tracker"\n');

      const backups = await filesUnder(
        join(wikiRoot, ".local", "telegram-wiki", "install-backup"),
      );
      expect(backups.some((path) => path.endsWith("AGENTS.md"))).toBe(true);
      expect(
        backups.some((path) => path.endsWith("external-automation.toml")),
      ).toBe(true);
    });
  });
});

async function write(path: string, text: string): Promise<void> {
  const target = join(wikiRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function filesUnder(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(rootPath, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}
