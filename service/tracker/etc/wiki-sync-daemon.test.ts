import { setTimeout } from "node:timers/promises";

import { assert, describe, expect, it, vi } from "vitest";

import { onlyForTesting } from "./wiki-sync-daemon.ts";

const { schedule } = onlyForTesting;

describe(schedule, () => {
  it("получает данные по таймеру, продолжает после ошибки и не перекрывает долгий запуск", async () => {
    const stop = new AbortController();
    let finish: (() => void) | undefined;
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("связь пропала"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const worker = schedule(run, {
      firstDelayMs: 10,
      intervalMs: 100,
      signal: stop.signal,
    });
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    await setTimeout(250);
    expect(run).toHaveBeenCalledTimes(2);
    assert(finish);
    finish();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(3);
    });
    stop.abort();
    await worker;
    await setTimeout(150);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
