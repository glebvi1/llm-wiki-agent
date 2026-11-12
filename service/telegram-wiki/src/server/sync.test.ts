import { describe, expect, it, vi } from "vitest";

import { TelegramImporter } from "#src/server/importer.ts";
import { WikiStore } from "#src/server/store.ts";
import { SyncCoordinator } from "#src/server/sync.ts";
import { FakeTelegramGateway } from "#src/server/test/fake-gateway.ts";

describe("ручное обновление", () => {
  it("сначала получает Telegram, затем запускает обработку Wiki", async () => {
    const gateway = new FakeTelegramGateway();
    const importer = new TelegramImporter(new WikiStore("unused"), gateway);
    const events: string[] = [];
    vi.spyOn(importer, "syncAll").mockImplementation(() => {
      events.push("import");
      return Promise.resolve();
    });
    const coordinator = new SyncCoordinator(importer, {
      run() {
        events.push("process");
        return Promise.resolve();
      },
    });
    await coordinator.run();
    expect(events).toStrictEqual(["import", "process"]);
  });

  it("не запускает параллельные проходы и не обрабатывает сбой получения", async () => {
    const gateway = new FakeTelegramGateway();
    const importer = new TelegramImporter(new WikiStore("unused"), gateway);
    let finishImport: (() => void) | undefined;
    vi.spyOn(importer, "syncAll").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishImport = resolve;
        }),
    );
    const runner = {
      run: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
    const coordinator = new SyncCoordinator(importer, runner);
    const first = coordinator.run();
    const second = coordinator.run();
    expect(first).toBe(second);
    expect(runner.run).not.toHaveBeenCalled();
    finishImport?.();
    await first;
    expect(runner.run).toHaveBeenCalledExactlyOnceWith();
  });
});
