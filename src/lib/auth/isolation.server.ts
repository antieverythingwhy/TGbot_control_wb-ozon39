import { getRequest } from "@tanstack/react-start/server";

/**
 * Изоляция соседей через Fetch-Metadata — **только сервер** (суффикс `.server.ts`).
 *
 * ОБЯЗАТЕЛЬНО сохраняйте суффикс `.server`: этот файл импортирует `@tanstack/react-start/server`
 * (`getRequest` → Node `AsyncLocalStorage`). Если его импортировать из двойного
 * client/server-модуля под именем без `.server`, Vite отправит его в браузер,
 * и приложение умрёт с: `AsyncLocalStorage is not a constructor`.
 *
 * Приложения, задеплоенные на `*.grok.me`, «same-site» друг другу, но ВЗАИМНО
 * НЕДОВЕРЕННЫЕ, и cookie сессии `SameSite=Lax` ОТПРАВЛЯЕТСЯ на same-site
 * подзапросы — поэтому без этого злонамеренный сосед мог бы сделать СКРИПТОВЫЙ
 * (fetch/XHR/form-POST) запрос к server functions этого приложения и прокатиться на
 * cookie сессии этого приложения.
 *
 * Разрешаем только: same-origin запросы (собственный клиент этого приложения), небраузерные
 * запросы (SSR / server-to-server, которые не шлют `Sec-Fetch-Site`) и
 * top-level GET-навигации (так приходят OAuth callback и обычные загрузки
 * страниц). Каждый cross-site / same-site *скриптовый* запрос отклоняется.
 * Вместе с cookie `__Host-` и `trustedOrigins` Better Auth это
 * закрывает поверхность атаки соседних тенантов. Применяется в узком месте `authMiddleware`
 * (см. `middleware.ts`).
 */
export class CrossSiteRequestError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden: cross-site request blocked");
    this.name = "CrossSiteRequestError";
  }
}

/** Бросить `CrossSiteRequestError` для скриптового cross-site/соседнего запроса. */
export function assertSameSiteRequest(): void {
  const request = getRequest();
  if (!request) return; // нет контекста запроса (напр. сборка) — нечего охранять
  const h = request.headers;
  const site = h.get("sec-fetch-site");
  // Небраузерный клиент (нет заголовка), собственный origin приложения или прямая
  // загрузка (адресная строка/закладка) — всё это нормально.
  if (!site || site === "same-origin" || site === "none") return;
  // Top-level GET-навигация (напр. редирект OAuth callback брокера)
  // нормальна даже если она cross-site; скриптовые запросы никогда не ставят режим navigate.
  const dest = h.get("sec-fetch-dest");
  const isTopLevelGet =
    h.get("sec-fetch-mode") === "navigate" &&
    request.method === "GET" &&
    dest !== "object" &&
    dest !== "embed";
  if (isTopLevelGet) return;
  throw new CrossSiteRequestError();
}
