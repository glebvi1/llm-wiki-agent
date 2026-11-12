import { markTelegramConnected } from "#etc/install.ts";
import { loadConfig } from "#src/server/config.ts";
import { dependencies, startServer } from "#src/server/server.ts";
import { LocalTelegramRuntime } from "#src/server/telegram-runtime.ts";

const config = await loadConfig();
const runtime = new LocalTelegramRuntime(config, async () => {
  await markTelegramConnected(config.wikiRoot);
});
const deps = dependencies(config, undefined, undefined, runtime);
await runtime.start();
const app = await startServer(deps);
console.log(`Telegram Wiki: http://127.0.0.1:${String(config.port)}`);

let timer: NodeJS.Timeout | undefined;
if (config.enableSync) {
  timer = setInterval(() => {
    void deps.importer.syncAll();
  }, config.syncIntervalMs);
  timer.unref();
  setTimeout(() => {
    void deps.importer.syncAll();
  }, 1000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (timer) {
      clearInterval(timer);
    }
    void app.close().then(() => process.exit(0));
  });
}
