import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { developmentConfig } from "#src/server/config.ts";
import { buildServer, dependencies } from "#src/server/server.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = fileURLToPath(new URL("../src", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), await localApi()],
  server: {
    host: "127.0.0.1",
    port: 7100,
    strictPort: false,
    watch: { ignored: ["**/.work/**", "**/vendor/**"] },
  },
  preview: { host: "127.0.0.1", port: 7100, strictPort: false },
  resolve: { alias: [{ find: /^#src\//, replacement: `${src}/` }] },
  css: { preprocessorOptions: { scss: { loadPaths: [src] } } },
});

async function localApi(): Promise<Plugin> {
  const deps = dependencies(developmentConfig());
  await deps.runtime.start();
  const app = await buildServer(deps);
  await app.ready();
  return {
    name: "telegram-wiki-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/")) {
          app.server.emit("request", req, res);
          return;
        }
        next();
      });
      server.httpServer?.on("close", () => {
        void app.close();
      });
    },
  };
}
