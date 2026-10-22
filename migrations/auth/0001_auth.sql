-- Схема Better Auth (идентичность + сессии для "Sign in with Grok").
--
-- Сгенерировано CLI Better Auth для его адаптера Postgres — НЕ РЕДАКТИРУЙТЕ вручную.
-- `@/lib/auth/server` гоняет Better Auth по этим таблицам, когда задан
-- DATABASE_URL. Колонки в camelCase и ДОЛЖНЫ оставаться в двойных кавычках, чтобы
-- Postgres сохранял регистр, по которому запрашивает Better Auth.
--
-- Миграции в этой папке — единственный источник правды для схемы. Они
-- применяются к Neon во время сборки Vercel (`npm run build`) и к локальному
-- фолбэку PGLite автоматически при старте, чтобы dev совпадал с продом. Применённые
-- файлы записываются по имени в `_migrations` и БОЛЬШЕ НИКОГДА не запускаются.
--
-- Схему ВАШЕГО приложения кладите в НОВЫЕ упорядоченные файлы (0002_*.sql, 0003_*.sql, …), никогда
-- не в этот. Для таблиц приложения предпочитайте snake_case и давайте таблицам на пользователя колонку
-- `user_id TEXT NOT NULL` (TEXT, не UUID — id dev-пользователя превью это
-- строка 'dev-user'), затем ограничивайте каждый запрос аутентифицированным пользователем
-- на сервере (см. навыки `neon` + `auth` и src/lib/auth/verify.server.ts).

create table if not exists "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create table if not exists "session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create table if not exists "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null
);

create table if not exists "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create index if not exists "session_userId_idx" on "session" ("userId");
create index if not exists "account_userId_idx" on "account" ("userId");
create index if not exists "verification_identifier_idx" on "verification" ("identifier");
