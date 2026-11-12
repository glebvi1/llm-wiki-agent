import assert from "node:assert/strict";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emptyState, stateSchema, type WikiState } from "#src/model.ts";

export class WikiStore {
  private queue: Promise<void> = Promise.resolve();
  private current: WikiState | undefined;
  private loading: Promise<WikiState> | undefined;

  constructor(readonly wikiRoot: string) {}

  get statePath(): string {
    return join(this.wikiRoot, ".local", "telegram-wiki", "state.json");
  }

  async read(): Promise<WikiState> {
    if (!this.current) {
      this.loading ??= this.load()
        .then((state) => (this.current = state))
        .finally(() => {
          this.loading = undefined;
        });
      await this.loading;
    }
    assert(this.current);
    return structuredClone(this.current);
  }

  async update(
    change: (state: WikiState) => void | Promise<void>,
  ): Promise<WikiState> {
    const run = this.queue.then(async () => {
      const state = await this.read();
      await change(state);
      const validated = stateSchema.parse(state);
      await atomicJson(this.statePath, validated);
      this.current = validated;
      return structuredClone(validated);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<WikiState> {
    try {
      const text = await readFile(this.statePath, "utf8");
      return stateSchema.parse(JSON.parse(text));
    } catch (error) {
      if (isMissing(error)) {
        return emptyState();
      }
      throw error;
    }
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  const file = await open(temp, "w");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function assertInside(root: string, candidate: string): void {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  assert(
    normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}/`),
    "путь выходит за пределы Wiki",
  );
}
