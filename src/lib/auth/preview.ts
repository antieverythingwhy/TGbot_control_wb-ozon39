/**
 * Общий OAuth-клиент LIVE-PREVIEW (только сервер — НИКОГДА не импортируйте с клиента).
 *
 * Песочница отдаёт каждый live preview на динамическом URL `https://*.grok-sandbox.com`,
 * который нельзя заранее зарегистрировать для каждого приложения. Вместо этого брокер предоставляет ОДИН
 * общий клиент «preview», который принимает любой
 * `https://*.grok-sandbox.com/api/auth/oauth2/callback/*`
 * (брокер: `app-builder-deployer/auth/src/preview-oauth.ts`). Вшивание его сюда позволяет
 * live preview делать НАСТОЯЩИЙ вход — без демо/моковых пользователей — без внедрения
 * платформой. При деплое деплоер внедряет на приложение
 * `GROK_AUTH_*`, которые перекрывают эти значения (см. `server.ts`).
 *
 * Они ДОЛЖНЫ совпадать с `GROK_PREVIEW_CLIENT_ID` /
 * `GROK_PREVIEW_CLIENT_SECRET` брокера (заданы в Vercel env брокера; брокер хранит
 * только хеш секрета `base64url(SHA-256)`). Это выделенный клиент с низкими привилегиями
 * (только preview, `*.grok-sandbox.com`) — ротируйте его, перегенерировав
 * env-переменную брокера и эту константу вместе.
 */
export const PREVIEW_CLIENT_ID = "grok_preview";
export const PREVIEW_CLIENT_SECRET =
  "8bcdb7fc5a33874ad933ca568918d5790388a0795e44c4d1dea691f801b17ec5";

/** Издатель общего брокера аутентификации (под ним живёт OIDC discovery). */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Шаблоны хостов, чьи callback принимает preview-клиент. Better Auth выводит
 * настоящий origin live preview из хоста запроса и сверяет его с
 * этим списком (сопоставление по wildcard), так что OAuth `redirect_uri` становится конкретным
 * `https://<preview-host>/api/auth/oauth2/callback/...`, который разрешает брокер.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
