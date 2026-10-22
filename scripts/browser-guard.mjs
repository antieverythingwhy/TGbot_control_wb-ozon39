/**
 * Проверки цели, общие для скриптов захвата Playwright.
 *
 * Оба запускают Chromium с `--no-sandbox` от root и берут URL и путь вывода
 * из argv, поэтому без проверки отрисуют `file:///root/.grok/auth.json`
 * в PNG, который агент может прочитать, и запишут его куда угодно.
 */
import { resolve, sep } from "node:path";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Только http/https loopback, иначе exit 1. `BROWSER_ALLOW_EXTERNAL_HOST=1` отключает проверку. */
export function checkedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`not a valid URL: ${url}`);
  }
  // Отсекает file:, data:, chrome:, view-source:.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`only http/https URLs are allowed, got ${parsed.protocol} in ${url}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname) && process.env.BROWSER_ALLOW_EXTERNAL_HOST !== "1") {
    fail(
      `${parsed.hostname} is not a loopback host; these scripts screenshot the ` +
        `local dev server. Set BROWSER_ALLOW_EXTERNAL_HOST=1 to override.`,
    );
  }
  return url;
}

/** Абсолютный `target`, если он строго внутри `allowedDirs`, иначе exit 1. */
export function checkedOutputPath(target, allowedDirs, label = "screenshot") {
  // Сначала resolve, чтобы `..` не проскочил проверку префикса.
  const abs = resolve(target);
  const allowed = allowedDirs.some((dir) => abs.startsWith(dir.endsWith(sep) ? dir : dir + sep));
  if (!allowed) {
    fail(`${label} path must be under ${allowedDirs.join(" or ")}, got ${abs}`);
  }
  return abs;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
