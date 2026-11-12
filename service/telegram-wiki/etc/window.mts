import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const url = process.argv.at(-1);
if (url !== "http://127.0.0.1:7100/") {
  throw new Error("Некорректный адрес Telegram в LLM Wiki");
}

app.setName("Telegram в LLM Wiki");
app.setAppUserModelId("site.gyromind.telegram-wiki");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows().at(0);
    if (window?.isMinimized()) {
      window.restore();
    }
    window?.focus();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  void app
    .whenReady()
    .then(async () => {
      const window = new BrowserWindow({
        title: app.name,
        icon: fileURLToPath(new URL("./telegram-wiki.ico", import.meta.url)),
        width: 1150,
        height: 800,
        backgroundColor: "#17151c",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, target) => {
        if (new URL(target).origin !== new URL(url).origin) {
          event.preventDefault();
        }
      });
      await window.loadURL(url);
    })
    .catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
}
