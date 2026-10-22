#!/usr/bin/env node
/**
 * Громко падать, когда работающий dev-сервер и следующая сборка расходятся в
 * `VITE_AUTH_ENABLED`.
 *
 * `npm run dev`, `npm run build` и `npm run preview` все получают флаг из
 * `scripts/with-app-env.mjs`, поэтому согласованы по построению — но dev-сервер,
 * запущенный вне npm (`npx vite dev`), нет, и в итоге вход
 * виден в live-превью и отсутствует в собранном выводе, или наоборот.
 *
 * Сравниваются две стороны:
 *  - **dev**: что разрешил работающий сервер, читается с эндпоинта `/__app-env`,
 *    который отдаёт dev-only `appEnvPlugin` шаблона.
 *  - **build**: что обёртка передаёт в `vite build` / `vite preview`.
 *
 * Собранный бандл не читается: Vite инлайнит флаг, а минификатор выкидывает
 * `"false" !== "false"`, поэтому в собранном клиентском JS нет маркера для
 * сравнения, пока приложение само его не выдаст.
 *
 * `scripts/browser-smoke.mjs` гоняет сравнение на каждом smoke; отдельно против
 * живого dev-сервера — `npm run check:auth` (exit 0 согласованы,
 * 1 разошлись, 2 не удалось наблюдать). Вызывающим, которые сравнивают флаг, стоит брать
 * `compareAuthInvariant()`, а не выводить его заново.
 */
import { APP_ENV_ROUTE } from "./app-env-plugin.mjs";
import { isMainModule, mergeAppEnv, projectRoot, readAppEnv } from "./with-app-env.mjs";

const DEFAULT_DEV_URL = "http://127.0.0.1:8080";

/** Предикат, который `src/lib/auth/{client,server}.ts` применяют к флагу. */
export function authEnabledFromEnvValue(value) {
  return value !== "false";
}

/**
 * Сравнить два разрешённых значения. `null` значит «не удалось наблюдать» — это
 * неопределённость, а не согласие.
 */
export function compareAuthInvariant({ devAuthEnabled, buildAuthEnabled }) {
  const label = (value) => (value ? "on" : "off");
  if (devAuthEnabled === null || devAuthEnabled === undefined) {
    return {
      status: "indeterminate",
      message: "[auth-invariant] could not read the dev server's resolved VITE_AUTH_ENABLED",
    };
  }
  if (devAuthEnabled === buildAuthEnabled) {
    return {
      status: "ok",
      message: `[auth-invariant] dev and build agree: sign-in ${label(devAuthEnabled)}`,
    };
  }
  return {
    status: "diverged",
    message:
      `[auth-invariant] dev server has sign-in ${label(devAuthEnabled)} but the next ` +
      `build has it ${label(buildAuthEnabled)}. Start the app with \`npm run dev\` — ` +
      "invoking vite directly skips scripts/with-app-env.mjs, so the dev server and " +
      "the built output resolve .grok/app-env.json differently.",
  };
}

/**
 * Спросить у dev-сервера, какое окружение он разрешил. Всё, кроме JSON-объекта с
 * `/__app-env` (нет сервера, превью собранного вывода, старый воркспейс без
 * плагина) — это «не удалось наблюдать».
 */
export async function probeDevAuthEnabled(devUrl, fetchImpl = fetch) {
  let env;
  try {
    const response = await fetchImpl(new URL(APP_ENV_ROUTE, devUrl).href);
    if (!response.ok) return null;
    env = JSON.parse(await response.text());
  } catch {
    return null;
  }
  if (env === null || typeof env !== "object") return null;
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

/** Предупреждения smoke-вердикта для сравнения: только реальное расхождение. */
export function authInvariantWarnings(result) {
  return result.status === "diverged" ? [result.message] : [];
}

/** Что разрешат `vite build` / `vite preview`, через ту же обёртку. */
export function buildAuthEnabled(root = projectRoot(), processEnv = process.env) {
  const env = mergeAppEnv(readAppEnv(root), processEnv);
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

async function main(argv) {
  const devUrlFlag = argv.indexOf("--dev-url");
  const devUrl = devUrlFlag === -1 ? DEFAULT_DEV_URL : argv[devUrlFlag + 1];
  const result = compareAuthInvariant({
    devAuthEnabled: await probeDevAuthEnabled(devUrl),
    buildAuthEnabled: buildAuthEnabled(),
  });
  if (result.status === "ok") {
    console.log(result.message);
    process.exit(0);
  }
  console.error(result.message);
  process.exit(result.status === "diverged" ? 1 : 2);
}

if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
