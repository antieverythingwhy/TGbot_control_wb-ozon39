/**
 * Только для dev: эндпоинт `/__app-env` — клиентское окружение, которое разрешил
 * работающий сервер Vite, в виде JSON.
 *
 * `scripts/check-auth-invariant.mjs` читает его, чтобы сравнить `VITE_AUTH_ENABLED`
 * живого dev-сервера со значением, которое разрешит следующая сборка. Конфиг
 * загружается даже когда Vite запущен вне `scripts/with-app-env.mjs` —
 * тот случай, который эта проверка и должна ловить. Это те же значения, которые Vite инлайнит
 * в клиентский бандл, а `apply: "serve"` не пускает маршрут в задеплоенные
 * приложения.
 */
export const APP_ENV_ROUTE = "/__app-env";

export function appEnvPlugin() {
  return {
    name: "app-builder:app-env",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url ?? "").split("?", 1)[0];
        if (pathOnly !== APP_ENV_ROUTE || (req.method ?? "GET").toUpperCase() !== "GET") {
          next();
          return;
        }
        const body = Buffer.from(JSON.stringify(server.config.env), "utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("content-length", String(body.byteLength));
        res.end(body);
      });
    },
  };
}
