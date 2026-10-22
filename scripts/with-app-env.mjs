#!/usr/bin/env node
/**
 * Запустить команду с `.grok/app-env.json`, влитым в её окружение.
 *
 * `dev`, `build` и `preview` все идут через эту обёртку, поэтому dev-
 * сервер, собранный бандл и сервер превью не могут разойтись в
 * `VITE_AUTH_ENABLED` — расхождение, которое проявляется как несовпадение собранного вывода
 * лишь много позже. Всё, что запускает Vite напрямую, обходит её.
 *
 * Учитываются только ключи с префиксом `VITE_`: файл — носитель флагов сборки, не
 * хранилище секретов, и до браузера всё равно доходят только переменные `VITE_`. Настоящая
 * запись `process.env` всегда побеждает, поэтому явный override всё ещё работает.
 *
 * Этот приоритет также значит, что файл управляет только этим воркспейсом. Задеплоенная
 * сборка идёт с project env провайдера, где деплоер сам ставит
 * `VITE_AUTH_ENABLED` (сегодня безусловно `"true"`), поэтому задеплоенный
 * флаг — платформы, а не этого файла.
 *
 * Vite подхватывает значения, потому что `loadEnv` матчит по префиксу записи, уже лежащие в
 * `process.env`, поэтому слияние должно случиться до старта Vite.
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ENV_REL_PATH = ".grok/app-env.json";

const VITE_PREFIX = "VITE_";

/**
 * Разобрать документ app-env, оставив только строковые записи с префиксом `VITE_`.
 * Всё неразбираемое — пустое окружение: воркспейс без файла
 * должен вести себя ровно как сегодня (вход включён, без override).
 */
export function parseAppEnv(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const env = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith(VITE_PREFIX)) continue;
    if (typeof value !== "string") continue;
    env[key] = value;
  }
  return env;
}

/** Окружение приложения, записанное под `root`, или `{}`, если файла нет. */
export function readAppEnv(root) {
  try {
    return parseAppEnv(readFileSync(join(root, APP_ENV_REL_PATH), "utf8"));
  } catch {
    return {};
  }
}

/** Значения файла под окружением процесса: явный override побеждает. */
export function mergeAppEnv(appEnv, processEnv) {
  return { ...appEnv, ...processEnv };
}

/**
 * Перевести `(code, signal)` события `exit` потомка в код выхода этого процесса.
 *
 * Не поднимайте сигнал заново через `process.kill(process.pid, signal)`: под
 * qemu-user (сборки образа amd64 на arm-хосте) сигнал самому себе
 * регулярно доставляется как SIGSEGV не тому процессу, что роняет
 * воркер тестов и валит сборку образа. `128 + signo` — то, что shell сообщает
 * для команды, убитой сигналом, поэтому отменённый `vite build` всё ещё провал.
 */
export function exitStatusFromChild(code, signal) {
  if (signal) {
    const signo = osConstants.signals[signal];
    return 128 + (typeof signo === "number" ? signo : 1);
  }
  return code ?? 1;
}

/** Корень воркспейса (этот файл лежит в `<root>/scripts/`). */
export function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Является ли `moduleUrl` скриптом, который node попросили запустить.
 *
 * Обе стороны разрешаются через симлинки: node делает realpath для `import.meta.url`,
 * но оставляет `process.argv[1]` как набрали, поэтому сырое сравнение превращает CLI,
 * запущенный через симлинк (`/tmp` на macOS), в тихий no-op.
 */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    console.error("usage: node scripts/with-app-env.mjs <command> [args…]");
    process.exit(2);
  }
  const env = mergeAppEnv(readAppEnv(projectRoot()), process.env);
  // На Windows файл называется vite.cmd. Без shell Node его не находит и пишет ENOENT.
  // cwd — папка с package.json, даже если командную строку открыли внутри src.
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    cwd: projectRoot(),
    shell: process.platform === "win32",
  });
  // Dev-сервер долгоживущий и останавливается сигналом этой обёртке.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (err) => {
    console.error(`[with-app-env] failed to run ${command}:`, err?.message || err);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(exitStatusFromChild(code, signal));
  });
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
