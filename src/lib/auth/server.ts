/**
 * Самостоятельно размещённый Better Auth для ЭТОГО приложения (только сервер).
 *
 * Заранее подключён для live preview + деплоя — не переписывайте этот файл. Чтобы включить
 * локальные email/пароль, переключите флаг только в `./email-password` (см. skill auth).
 *
 * Приложение запускает свой Better Auth на `/api/auth/*`, поэтому cookie сессии остаётся
 * на собственном origin этого приложения. Вход федеративно идёт к общему **брокеру аутентификации Grok**
 * (`GROK_AUTH_ISSUER`) через плагин `genericOAuth` — брокер проксирует
 * методы входа upstream (Google, X, …) и хранит их общие секреты; это
 * приложение хранит только свой client id/secret и называет нужный upstream через
 * подсказку `idp` каждого провайдера.
 *
 * Три режима:
 *   - Задеплоено: деплоер внедряет на приложение `GROK_AUTH_*` + `BETTER_AUTH_URL`
 *     + `DATABASE_URL`, так что настоящая федеративная аутентификация сохраняется в Postgres.
 *   - Live preview песочницы: нет внедрения -> откат к общему **preview-
 *     клиенту** (`./preview`) и вывод origin preview `https://*.grok-sandbox.com`
 *     из запроса, так что настоящий вход работает (без демо-пользователей). Сессии
 *     и личности сохраняются во встроенной БД PGLite (та же БД, что и данные приложения);
 *     перезапуск процесса стирает и то, и другое. Клиенты iframe live-preview используют bearer-
 *     токен (раздельные cookie) — см. `client.ts`.
 *   - Выключено (`VITE_AUTH_ENABLED=false`, значение по умолчанию в поставке): нет провайдеров;
 *     `requireUserId` разрешает dev-пользователя, если база не настроена, и
 *     бросает fail-closed, как только задан `DATABASE_URL` (см. `verify.server.ts`).
 *
 * НИКОГДА не импортируйте это из клиентского кода — оно тянет `pg` + секрет preview +
 * внутренности Better Auth только для сервера. Клиент использует `@/lib/auth/client`;
 * компоненты читают пользователя через `@/lib/auth/use-current-user`; server functions получают
 * проверенный id через `@/lib/auth/middleware`.
 */
import { betterAuth } from "better-auth";
import { bearer, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { ensureDbReady, getPglite } from "../db";
import { emailAndPasswordEnabled } from "./email-password";
import { GATE_PROVIDER_ID, gateIdentitySessions } from "./gate-session.server";
import { GROK_PROVIDERS } from "./providers";
import { pgliteDialect } from "./pglite-dialect";
import {
  GROK_ISSUER_DEFAULT,
  PREVIEW_ALLOWED_HOSTS,
  PREVIEW_CLIENT_ID,
  PREVIEW_CLIENT_SECRET,
} from "./preview";

// Запустить (и разделить) bootstrap PGLite, как только загрузится модуль auth-сервера.
void ensureDbReady();

/**
 * Секрет preview должен пережить перезагрузки модуля: PGLite (и его строки сессий)
 * лежит на `globalThis`, поэтому повторная оценка этого файла при HMR НЕ должна чеканить новый
 * секрет подписи, иначе каждая существующая сессия станет невалидной посреди разработки. Перезапуск
 * процесса очищает и секрет, и PGLite вместе.
 */
const globalAuthRef = globalThis as typeof globalThis & {
  __grokAuthPreviewSecret__?: string;
};
function previewAuthSecret(): string {
  globalAuthRef.__grokAuthPreviewSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__grokAuthPreviewSecret__;
}

/** Прочитать env-переменную, считая пустую строку/пробелы как незаданную. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

// Явный выключатель. Деплоер ставит `VITE_AUTH_ENABLED=true`, когда
// провижинит auth; поставьте "false", чтобы принудительно выключить auth везде (dev-пользователь).
const authDisabled = env("VITE_AUTH_ENABLED") === "false";

// Учётные данные федерации брокера: деплоер внедряет клиент на приложение при деплое;
// иначе откат к общему клиенту live-preview, который брокер принимает
// для любого callback `*.grok-sandbox.com` (см. `./preview`).
const grokIssuer = env("GROK_AUTH_ISSUER") ?? GROK_ISSUER_DEFAULT;
const grokClientId = env("GROK_AUTH_CLIENT_ID") ?? PREVIEW_CLIENT_ID;
const grokClientSecret = env("GROK_AUTH_CLIENT_SECRET") ?? PREVIEW_CLIENT_SECRET;

/** Истина, когда федеративный вход активен (настоящий auth принуждается). */
export const authConfigured =
  !authDisabled && Boolean(grokClientId && grokClientSecret);

// Собственный origin Better Auth этого приложения. При деплое деплоер внедряет
// публичный URL. В live preview песочницы нет фиксированного URL (каждый preview получает
// динамический хост `*.grok-sandbox.com`), поэтому отдаём Better Auth динамический baseURL:
// он выводит origin на каждый запрос из (проксированного) хоста, сверяя с
// allowlist preview, из-за чего OAuth `redirect_uri` становится конкретным URL preview,
// который принимает preview-клиент брокера.
const explicitBaseURL = env("BETTER_AUTH_URL");
// Явный `string[]` (не readonly-кортеж) — DynamicBaseURLConfig Better Auth
// требует изменяемый `allowedHosts: string[]`.
const previewAllowedHosts: string[] = [...PREVIEW_ALLOWED_HOSTS];
// Локальный `npm run dev` (контракт порта 8080). Браузеры могут прислать Origin любым из
// этих вариантов для того же сервера — доверие только `localhost` отклоняет `127.0.0.1` и
// ломает email/пароль с "Invalid origin".
const LOCAL_DEV_ORIGINS: string[] = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];
const baseURL = explicitBaseURL ?? {
  // Включить loopback-хосты, чтобы динамический baseURL резолвился для локальных email/пароля
  // (а не только wildcard preview).
  allowedHosts: [...previewAllowedHosts, "localhost", "127.0.0.1", "[::1]"],
  // `auto` → доверять и http://, и https://-развёрткам allowedHosts
  // (preview — https; локальная разработка — http).
  protocol: "auto" as const,
  fallback: "http://localhost:8080",
};

// Origin'ы, которые Better Auth принимает на credentialed POST (регистрация/вход и т.д.).
// Пропущенные здесь записи всплывают как FORBIDDEN "Invalid origin".
const trustedOrigins: string[] = explicitBaseURL
  ? [explicitBaseURL, ...LOCAL_DEV_ORIGINS]
  : [
      // Wildcard хостов (сопоставляются с хостом Origin)
      ...previewAllowedHosts,
      // Wildcard полного origin (сопоставляются с Origin)
      ...previewAllowedHosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
      ...LOCAL_DEV_ORIGINS,
    ];

const databaseUrl = env("DATABASE_URL");

// Статические OAuth-эндпоинты брокера (пропустить OIDC discovery на каждом входе / callback).
// Discovery стоил бы лишнего сетевого хопа к брокеру, прежде чем popup сможет
// вообще редиректнуть на Google/X — popup live-preview ощущался застрявшим на приложении на
// весь этот round-trip. Эти пути совпадают с документом discovery брокера.
const issuerBase = grokIssuer.replace(/\/+$/, "");
const grokAuthorizationUrl = `${issuerBase}/api/auth/oauth2/authorize`;
const grokTokenUrl = `${issuerBase}/api/auth/oauth2/token`;
const grokUserInfoUrl = `${issuerBase}/api/auth/oauth2/userinfo`;

// Настоящий Postgres, когда задан `DATABASE_URL` (задеплоенные приложения), иначе встроенный
// PGLite приложения (preview) через диалект Kysely — чтобы Better Auth писал в ТУ ЖЕ
// БД, что и данные приложения, включая пользователей email/пароля. Оба используют схему Better Auth
// из `migrations/auth/0001_auth.sql`, копируемую в `migrations/`, когда
// приложение включает вход.
const database = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };

/** Имя cookie токена сессии — его также читает страница завершения popup live-preview. */
export const SESSION_TOKEN_COOKIE = "__Host-grok-auth.session_token";

// Собран отдельно, чтобы вызов `betterAuth({...})` было легко править, не
// ломая скобки (модели часто спотыкаются об условный spread плагинов).
const grokOAuthPlugin = authConfigured
  ? genericOAuth({
      config: GROK_PROVIDERS.map(({ providerId, idp }) => ({
        providerId,
        clientId: grokClientId as string,
        clientSecret: grokClientSecret as string,
        // Предпочесть статические эндпоинты `discoveryUrl`, чтобы начало (и
        // завершение) OAuth не ждало fetch discovery брокера.
        authorizationUrl: grokAuthorizationUrl,
        tokenUrl: grokTokenUrl,
        userInfoUrl: grokUserInfoUrl,
        scopes: ["openid", "profile", "email"],
        // `prompt: "login"` заставляет брокера заново аутентифицироваться у
        // upstream на каждом входе вместо тихого переиспользования существующей
        // сессии брокера. Вместе с тем, что брокер шлёт Google
        // `prompt=select_account`, пользователь всегда получает выбор аккаунта
        // и может выбрать (или сменить), каким аккаунтом входить.
        authorizationUrlParams: { idp, prompt: "login" },
      })),
    })
  : null;

export const auth = betterAuth({
  baseURL,
  // Задеплоенные приложения внедряют BETTER_AUTH_SECRET. Preview: стабильный на процесс секрет на
  // globalThis, чтобы HMR не инвалидировал сессии на PGLite (см. выше).
  secret: env("BETTER_AUTH_SECRET") ?? previewAuthSecret(),
  database,

  // Проверка CSRF / origin для credentialed POST аутентификации (регистрация/вход по email, …).
  // См. сборку `trustedOrigins` выше — должна покрывать хосты live preview И
  // варианты локального loopback, иначе клиенты получают "Invalid origin".
  trustedOrigins,

  // Шифровать выданные брокером OAuth-токены в покое и считать upstream брокера
  // доверенными first-party личностями. Брокер владеет личностью, а email X
  // синтетические/непроверенные, поэтому БЕЗ этого вход может упасть с
  // `account_not_linked` (Better Auth отказывается прикрепить недоверенную непроверенную
  // личность к существующему пользователю). У Google и X РАЗНЫЕ email, поэтому это
  // никогда не сливает их в одного пользователя — они остаются отдельными личностями.
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: [
        ...GROK_PROVIDERS.map((p) => p.providerId),
        GATE_PROVIDER_ID,
      ],
      // Синтетический email X никогда не «verified», поэтому не ставьте связывание в зависимость от
      // состояния email-verified локального пользователя.
      requireLocalEmailVerified: false,
    },
  },

  // Кэшировать сессию в короткоживущей подписанной cookie `session_data`, чтобы чтения
  // (включая клиентский `/get-session`) пропускали БД — это сжимает окно «loading»
  // и уменьшает мерцание auth. См. skill `auth` за полным
  // руководством по предотвращению мерцания (гейт на `isPending`; SSR сессии).
  session: { cookieCache: { enabled: true, maxAge: 300 } },

  // Локальные email/пароль — переключаются только через `./email-password` (не плагин).
  ...(emailAndPasswordEnabled ? { emailAndPassword: { enabled: true } } : {}),

  // Cookie с префиксом `__Host-`: браузер ОТКАЗЫВАЕТ любой одноимённой cookie, которая
  // несёт атрибут `Domain`, поэтому соседнее приложение `*.grok.me` не может «подкинуть»
  // cookie сессии `Domain=.grok.me` этому приложению. `__Host-` требует Secure +
  // Path=/ + без Domain; иначе Better Auth использует `__Secure-` (который разрешает
  // Domain), поэтому мы отключаем его автопрефикс (`useSecureCookies: false`) и задаём
  // Secure + имена сами. (Браузеры разрешают Secure-cookie на
  // `http://localhost`, так что локальная разработка всё ещё работает.)
  advanced: {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
    cookies: {
      session_token: { name: SESSION_TOKEN_COOKIE },
      session_data: { name: "__Host-grok-auth.session_data" },
      account_data: { name: "__Host-grok-auth.account_data" },
      dont_remember: { name: "__Host-grok-auth.dont_remember" },
    },
  },

  plugins: [
    gateIdentitySessions(),

    // По одному провайдеру genericOAuth на upstream (когда auth включён), все федеративно
    // к брокеру с ТЕМ ЖЕ клиентом и различаются только подсказкой `idp`.
    ...(grokOAuthPlugin ? [grokOAuthPlugin] : []),

    // Принимать `Authorization: Bearer <session-token>` как альтернативу
    // cookie. Нужно для LIVE PREVIEW: приложение работает во встроенном iframe,
    // где cookie разделены, поэтому после входа через popup оно аутентифицируется
    // bearer-токеном (см. `client.ts` / skill `auth`). Хук срабатывает только
    // когда присутствует заголовок Authorization, так что путь через cookie
    // (задеплоенные приложения) не затронут.
    bearer(),

    // Мостит Set-Cookie Better Auth в ответы TanStack Start. ДОЛЖЕН быть
    // последним, чтобы выполняться после хуков всех остальных плагинов.
    tanstackStartCookies(),
  ],
});

export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}

// Реэкспорт для удобства; массив живёт в свободном от зависимостей
// `providers.ts`, чтобы клиент тоже мог его импортировать.
export { GROK_PROVIDERS } from "./providers";
