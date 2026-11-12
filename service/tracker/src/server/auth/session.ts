import { SignJWT, jwtVerify } from "jose";

import { config } from "#src/server/config.ts";

// Подпись и проверка session-cookie (JWT, jose). Система однопользовательская: учёток нет,
// поэтому в токене нечего хранить — валидная подпись и есть авторизация. Полезная нагрузка
// сведена к субъекту-владельцу: он отличает наш токен от чужого, подписанного тем же секретом.
// httpOnly + SameSite=Lax; `secure` только в проде, иначе cookie не ставится на http://localhost.

export const SESSION_COOKIE = "tracker_session";

/** 90 дней: вход личный и единственный, частый перелогин — трение без выигрыша в защите. */
const MAX_AGE_SEC = 60 * 60 * 24 * 90;

const OWNER = "owner";

export async function signSession(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime(`${String(MAX_AGE_SEC)}s`)
    .sign(secret());
}

/** Валиден ли токен из cookie. Просроченный и подделанный неотличимы — оба просто `false`. */
export async function verifySession(token: string): Promise<boolean> {
  return (await sessionIssuedAt(token)) !== null;
}

/** Когда выпущен валидный токен, в секундах Unix; `null` — токен не наш, подделан или истёк. */
export async function sessionIssuedAt(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.sub !== OWNER) {
      return null;
    }
    return payload.iat ?? 0;
  } catch {
    return null;
  }
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.isProduction,
    path: "/",
    maxAge: MAX_AGE_SEC,
  };
}

function secret(): Uint8Array {
  return new TextEncoder().encode(config.authSecret);
}
