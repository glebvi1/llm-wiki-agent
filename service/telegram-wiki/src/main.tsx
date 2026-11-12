import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "#src/app.tsx";

import "#src/ui/global.scss";

const root = document.getElementById("root");
if (!root) {
  throw new Error("не найден контейнер #root");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
