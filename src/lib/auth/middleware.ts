import { createMiddleware } from "@tanstack/react-start";

/**
 * Auth-middleware для server functions — стандартный способ получить проверенный
 * id пользователя вызывающего. При деплое cookie сессии same-origin и едет
 * сама. В live preview клиент также пересылает bearer-
 * токен (раздельные cookie) через хук `.client` ниже — места вызова сами его
 * не прокидывают.
 *
 *   import { createServerFn } from "@tanstack/react-start";
 *   import { getSql } from "@/lib/db";
 *   import { authMiddleware } from "@/lib/auth/middleware";
 *
 *   export const listTodos = createServerFn({ method: "GET" })
 *     .middleware([authMiddleware])
 *     .handler(async ({ context }) => {
 *       const sql = await getSql();
 *       return sql`select * from todos where user_id = ${context.userId}`;
 *     });
 *
 * Не вошёл при включённом auth (включая live preview) -> бросает `UnauthorizedError`
 * (см. `verify.server.ts`). При выключенном auth (`VITE_AUTH_ENABLED=false`,
 * значение по умолчанию в поставке) разрешает общего dev-пользователя — но вместо этого бросает, когда
 * также задан `DATABASE_URL`, поэтому приложение без входа не должно использовать это
 * вообще. На пути с включённым auth используйте это на каждой server function, которая трогает
 * данные пользователя, и ограничивайте каждый запрос через `context.userId`.
 */
export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Live preview (разделённый iframe): сессия едет bearer-токеном, а не
    // cookie, поэтому пересылаем его на сервер. Null при деплое (аутентификация по cookie), так что
    // там это no-op.
    const { getBearerToken } = await import("./client");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    // Импортируйте здесь ТОЛЬКО модули `*.server`. Этот файл двойной client/server
    // (хук bearer на клиенте). Обычный путь `./isolation` был переименован в
    // `isolation.server.ts` — держите этот импорт в синхроне, чтобы image `tsc` резолвил
    // его, и чтобы Vite не отправил `@tanstack/react-start/server` в браузер.
    const { assertSameSiteRequest } = await import("./isolation.server");
    const { requireUserId } = await import("./verify.server");
    // Отклоняем скриптовые cross-site/соседние запросы до того, как трогать данные пользователя.
    assertSameSiteRequest();
    const userId = await requireUserId(context.bearerToken);
    return next({ context: { userId } });
  });
