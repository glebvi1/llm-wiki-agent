import type { TelegramImporter } from "#src/server/importer.ts";

export interface WikiRunner {
  run(): Promise<void>;
}

export class SyncCoordinator {
  private current: Promise<void> | undefined;

  constructor(
    private readonly importer: TelegramImporter,
    private readonly runner: WikiRunner,
  ) {}

  run(): Promise<void> {
    this.current ??= this.synchronize().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async synchronize(): Promise<void> {
    await this.importer.syncAll();
    await this.runner.run();
  }
}
