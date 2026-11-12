import type { Chat, ChatState } from "#src/model.ts";

export type ChatView = Chat & { settings: ChatState | null };
export type DeletionPreview = { sources: string[]; derivedPages: string[] };
export type TelegramConnection = {
  status:
    | "idle"
    | "starting"
    | "qr"
    | "password"
    | "checking"
    | "connected"
    | "error";
  credentials: boolean;
  gatewayRunning: boolean;
  qrSvg: string | null;
  detail: string | null;
};

export async function chats(): Promise<ChatView[]> {
  return request("GET", "/api/chats");
}

export async function processingStatus(): Promise<{ enabled: boolean }> {
  return request("GET", "/api/processing");
}

export async function configureChat(
  id: string,
  settings: {
    enabled: boolean;
    importFrom: "now" | "date" | "all";
    fromDate: string | null;
    comment?: string;
  },
): Promise<ChatState> {
  return request("PUT", `/api/chats/${encodeURIComponent(id)}`, settings);
}

export async function updateChat(
  id: string,
  settings: { enabled: false } | { comment: string },
): Promise<ChatState> {
  return request("PATCH", `/api/chats/${encodeURIComponent(id)}`, settings);
}

export async function syncNow(): Promise<void> {
  await request("POST", "/api/sync");
}

export async function deletionPreview(id: string): Promise<DeletionPreview> {
  return request("POST", `/api/chats/${encodeURIComponent(id)}/delete-preview`);
}

export async function deleteSources(id: string): Promise<void> {
  await request("DELETE", `/api/chats/${encodeURIComponent(id)}/sources`, {
    confirmation: "УДАЛИТЬ",
  });
}

export async function telegramStatus(): Promise<TelegramConnection> {
  return request("GET", "/api/telegram/status");
}

export async function loginTelegram(): Promise<TelegramConnection> {
  return request("POST", "/api/telegram/login");
}

export async function submitTelegramPassword(
  password: string,
): Promise<TelegramConnection> {
  return request("POST", "/api/telegram/password", { password });
}

export async function cancelTelegramLogin(): Promise<TelegramConnection> {
  return request("POST", "/api/telegram/cancel");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("ok" in payload) ||
    payload.ok !== true ||
    !("result" in payload)
  ) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload &&
      typeof payload.detail === "string"
        ? payload.detail
        : `Ошибка ${String(response.status)}`;
    throw new Error(detail);
  }
  return payload.result as T;
}
