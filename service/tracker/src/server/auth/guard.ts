import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  SESSION_COOKIE,
  cookieOptions,
  sessionIssuedAt,
  signSession,
  verifySession,
} from "#src/server/auth/session.ts";
import { config } from "#src/server/config.ts";

// Доступ к сессии в обработчиках Fastify: гвард, установка и снятие cookie.

/**
 * Как часто перевыпускать cookie. Не на каждый запрос: плеер во время прослушивания шлёт
 * позицию каждые несколько секунд, и новый JWT на каждый такой запрос — работа без пользы.
 * Двенадцать часов на фоне 90 дней срока ничего не меняют.
 */
const RESLIDE_AFTER_SEC = 12 * 60 * 60;

/**
 * Скользящий вход: валидная cookie старше `RESLIDE_AFTER_SEC` перевыпускается, и 90 дней
 * отсчитываются от последнего использования приложения с сетью, а не от ввода пароля. Иначе
 * телефон, который открывают каждый день, всё равно разлогинивался бы раз в три месяца — и
 * посреди метро раздел «Слушать» терял бы синхронизацию.
 *
 * Выход не продлевается — иначе ответ одновременно стирал бы cookie и ставил новую. Публичные
 * capability-ссылки живут без сессии, и ставить на них cookie незачем.
 */
export async function slideSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { url } = req;
  if (
    !url.startsWith("/api/") ||
    url.startsWith("/api/auth/logout") ||
    url.startsWith("/api/public/")
  ) {
    return;
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    return;
  }
  const issuedAt = await sessionIssuedAt(token);
  if (issuedAt === null || Date.now() / 1000 - issuedAt < RESLIDE_AFTER_SEC) {
    return;
  }
  await setSession(reply);
}

/**
 * Пропускает только владельца. Бросает `HttpError` — его перехватывает общий обработчик ошибок
 * в `#src/server/server.ts` и превращает в `{ ok: false, detail }` с кодом 401.
 */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  if (req.headers.authorization !== undefined) {
    if (wikiAuthorized(req.headers.authorization)) {
      return;
    }
    throw new HttpError(401, "неверный токен подключения");
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token || !(await verifySession(token))) {
    throw new HttpError(401, "нужен вход");
  }
}

export function wikiAuthorized(authorization: string | undefined): boolean {
  const supplied = Buffer.from(
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
  );
  const expected = Buffer.from(config.wikiApiToken);
  return (
    expected.length >= 32 &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}

export async function setSession(reply: FastifyReply): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await signSession(), cookieOptions());
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Ожидаемая ошибка на границе API с HTTP-кодом. Поле объявлено явно (без parameter property):
// Node исполняет TypeScript стиранием типов и parameter properties не поддерживает.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}
