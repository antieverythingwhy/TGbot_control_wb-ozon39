import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS-плагин рядом с TS-конфигом vite
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS-плагин рядом с TS-конфигом vite
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** Файлы, которые глобит `src/lib/db.ts` — та же директория, тот же нерекурсивный охват. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Закончить бутстрап PGLite при настройке dev-сервера (до трафика). Vite ждёт
 * асинхронные хуки `configureServer`. В проде `src/lib/db` вызывает `ensureDbReady`
 * при импорте.
 *
 * Ожидание хука Vite ставит это на путь до первого рендера, поэтому приложение без
 * миграций — без схемы, которую нужно применить — пропускает шаг целиком, а не платит за
 * экземпляр PGLite, к которому никогда не обращается.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * OAuth-попап live-превью — обрабатывается ЗДЕСЬ, чтобы агенту не пришлось создавать
 * маршрут `/auth/popup` (и он не мог сломать его, собрав React-страницу, которая
 * рисует полную оболочку приложения в попапе).
 *
 * `signIn` (client.ts) открывает `/auth/popup?providerId=…` в окне верхнего уровня.
 * Этот middleware выполняется до TanStack Start, вызывает `handleAuthPopupRequest`
 * и возвращает 302 / HTML завершения. Задеплоенные приложения не используют попап
 * (полностраничный OAuth-редирект), поэтому достаточно `apply: "serve"`.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Регистрируем сразу (не в возвращаемом post-hook), чтобы выполниться ДО
      // TanStack Start / HTML-фолбэка SPA. Написанная моделью React-страница
      // `src/routes/auth/popup.tsx` никогда не должна перехватить этот путь.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Гарантируем, что Host — публичный хост превью, чтобы динамические
          // baseURL / redirect_uri Better Auth совпадали с origin попапа.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Сохраняем несколько заголовков Set-Cookie (состояние OAuth + сессия).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

// `0.0.0.0:8080` — контракт live-превью: не меняйте host/port.
// Dev-сервер стартует, когда существуют `src/router.tsx` и `src/routes/` — см.
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    pgliteBootstrapPlugin(),
    // До tanstackStart, чтобы /auth/popup никогда не проваливался в SPA.
    authPopupPlugin(),
    // Только для dev: /__app-env, его читает scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + страница туториала ?install=1; выполняется до Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            // Авторегистрация server/middleware/* (страница установки PWA +
            // манифест + middleware тегов head). В Nitro v3 serverDir по умолчанию
            // false, поэтому удаление этого тихо отключает /?install=1 на деплоях.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
