import { getRequest } from "@tanstack/react-start/server";
import { gateIdentityEnabled } from "./gate-identity.server";
import { auth, authConfigured } from "./server";

/**
 * Разрешение сессии на сервере (только сервер).
 *
 * Поскольку это приложение запускает СВОЙ Better Auth на same-origin `/api/auth/*`,
 * cookie сессии отправляется с каждым запросом к этому приложению — включая server functions И
 * SSR-лоадеры. Поэтому разрешаем пользователя прямо из cookie запроса
 * через `auth.api.getSession` (клиентский JWT не нужен). Никогда не доверяйте
 * id пользователя, пришедшему от клиента — только результату этой проверки.
 */

/** Истина, когда на сервере настроена настоящая база данных. */
const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());

/** Реэкспорт, чтобы вызывающие могли ветвиться по нему, не импортируя `server.ts`. */
export { authConfigured };

if (databaseConfigured && !authConfigured) {
  console.error(
    "[auth] DATABASE_URL is set but auth is disabled (VITE_AUTH_ENABLED=false) " +
      "— requireUserId() will reject every request (fail closed) rather than " +
      "share one dev user on a real database.",
  );
}

/** Id запасного dev-пользователя, используется только когда auth выключен (VITE_AUTH_ENABLED=false). */
export const DEV_USER_ID = "dev-user";

/**
 * Бросается `requireUserId`, когда у вызывающего нет валидной сессии. Несёт
 * `status: 401`; сообщение — стабильный контракт: сверяйте
 * `err.message === "Unauthorized"` на клиенте, чтобы отправить посетителя на вход.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Разрешить вошедшего пользователя из текущего запроса или `null`, когда auth не
 * настроен / никто не вошёл. Безопасно вызывать из server functions и SSR-
 * лоадеров.
 *
 * `bearerToken` — для LIVE PREVIEW: приложение работает в разделённом iframe,
 * чьи cookie не доходят до сервера, поэтому `authMiddleware` пересылает сессию
 * как bearer-токен, который мы предъявляем как `Authorization: Bearer …` (плагин `bearer`
 * его разрешает). При деплое токен не передаётся, и используется cookie.
 */
export async function getSessionUser(
  bearerToken?: string,
): Promise<VerifiedUser | null> {
  if (!authConfigured && !gateIdentityEnabled()) return null;
  const request = getRequest();
  if (!request) return null;
  let headers = request.headers;
  if (bearerToken) {
    headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/**
 * Разрешить id текущего пользователя для server function или бросить, если не авторизован.
 * Предпочитайте `authMiddleware` (`./middleware`), который вызывает это за вас.
 * - Auth включён -> проверенный id пользователя сессии; бросает
 *   `UnauthorizedError`, когда не вошли. Работает и в preview песочницы (настоящий
 *   вход через вшитый preview-клиент).
 * - Auth выключен (`VITE_AUTH_ENABLED=false`) + задан `DATABASE_URL` -> бросить (fail
 *   closed): один общий dev-пользователь на настоящей базе позволил бы каждому посетителю
 *   читать/писать чужие строки.
 * - Auth выключен + нет базы -> id общего dev-пользователя.
 */
export async function requireUserId(bearerToken?: string): Promise<string> {
  if (!authConfigured && !gateIdentityEnabled()) {
    if (databaseConfigured) {
      throw new Error(
        "Auth is disabled (VITE_AUTH_ENABLED=false) but DATABASE_URL is set — " +
          "refusing to fall back to the shared dev user against a real database.",
      );
    }
    return DEV_USER_ID;
  }
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}
