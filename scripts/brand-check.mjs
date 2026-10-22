#!/usr/bin/env node
/**
 * Гейт бренд-ассетов, общий с browser-smoke.mjs (и тестируемый без
 * браузера): canvas-приложение почти всегда игра / визуально насыщенное приложение, и
 * им нужна своя карточка шаринга — плейсхолдер og.grok.me по умолчанию
 * для них неприемлем (см. .grok/skills/og/SKILL.md).
 *
 * Игры также должны задать type=x:game в src/lib/og/site.json, чтобы платформенный
 * инжектор выдал og:type для разворотов игровой карточки X, и public/x-banner.jpg для
 * карточки ленты X 50:11. Файла карточки достаточно, чтобы bake выдал /og.jpg, но
 * brand-check всё равно требует в site.json `"card": "custom"`, чтобы контракт для агента
 * оставался явным.
 *
 * Проверяется по файловой системе (не по отданному head), чтобы превью и воркспейсы
 * в середине скаффолда судились одинаково.
 *
 * Также запускается отдельно, чтобы фоновая задача бренда могла проверить свою работу до
 * отчёта (родитель отвечает, не дожидаясь её):
 *
 *   node scripts/brand-check.mjs [--game] [--placeholder-ok] [--root <dir>]
 *
 * Этот запуск судит файлы на диске, даже если задача держит
 * маркер og-pending; маркер глушит только то, что видят гейты родителя. Он
 * также требует свою карточку: вызывающий обычно и есть проход, который существует, чтобы
 * её сделать, поэтому плейсхолдер, который родитель терпит для простой утилиты, здесь
 * провал прохода. --placeholder-ok — для другого запуска: проход, который делает
 * favicon, иконки PWA и заголовок для простой утилиты, оставляющей карточку og.grok.me, —
 * где отсутствие карточки ожидаемый вердикт, а не провал.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OG_SITE_REL_PATH, readOgSite, siteHasCustomCard } from "./grok-pwa-shared.mjs";

// Выше этого скрейперы ссылок (включая превью карточек X) отваливаются по таймауту или пропускают
// картинку, и карточка молча не разворачивается. JPEG-контракт навыка og
// (ffmpeg -q:v 4, ~150-300 KB) существует именно чтобы остаться ниже.
export const MAX_CARD_BYTES = 600 * 1024;

// Пишет задача бренда, пока генерирует, и снимает, когда заканчивает.
export const OG_PENDING_REL_PATH = ".grok/og-pending";
// Stop посреди генерации оставляет маркер, поэтому понижение истекает,
// а не прячет отсутствующую карточку на этом воркспейсе навсегда.
export const OG_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export function siteDeclaresOgTypeGame(site) {
  return String(site?.type ?? "").toLowerCase() === "x:game";
}

export function ogPendingActive(workspaceRoot, now = Date.now()) {
  try {
    const { mtimeMs } = statSync(join(workspaceRoot, OG_PENDING_REL_PATH));
    return now - mtimeMs < OG_PENDING_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * То, что видят гейты родителя. Проход бренда может ещё генерировать, когда
 * гейт бежит, и «missing» отправило бы агента переделывать работу задачи.
 *
 * В полёте — тишина, не заметка: вызывающие сообщают этот массив как предупреждения, поэтому
 * всё, что в нём осталось — как бы ни было сформулировано — доходит до агента как одно.
 */
export function computeBrandWarnings({
  hasCanvas,
  workspaceRoot = "/workspace",
  now = Date.now(),
}) {
  if (ogPendingActive(workspaceRoot, now)) return [];
  return brandWarningsOnDisk({ hasCanvas, workspaceRoot });
}

/**
 * Файлы на диске, маркер игнорируется — собственный взгляд прохода бренда на свою работу.
 * Нарочно не экспортируется: гейт, который потянулся бы сюда вместо
 * `computeBrandWarnings`, предупредил бы о карточке, которая ещё генерируется.
 * `cardRequired` — для вызывающего, который сам и есть проход бренда: для него
 * плейсхолдер — провал, а не умолчание простой утилиты, которое гейт родителя
 * оставляет в покое.
 */
function brandWarningsOnDisk({
  hasCanvas,
  workspaceRoot = "/workspace",
  cardRequired = false,
}) {
  const skillPath = join(workspaceRoot, ".grok/skills/og/SKILL.md");
  const sitePath = join(workspaceRoot, OG_SITE_REL_PATH);
  const site = readOgSite(workspaceRoot);
  const cardPath = [
    join(workspaceRoot, "public/og.jpg"),
    join(workspaceRoot, "public/og.png"),
  ].find(existsSync);
  const warnings = [];

  if (cardPath !== undefined) {
    if (statSync(cardPath).size > MAX_CARD_BYTES) {
      warnings.push(
        `BRAND WARNING: ${cardPath} is over 600 KB — link scrapers (X card previews included) `
          + "time out or skip images this heavy, so the card silently fails to unfurl. "
          + `Re-encode as JPEG (public/og.jpg, ffmpeg -q:v 4) per ${skillPath}.`,
      );
    }
    if (!siteHasCustomCard(site)) {
      warnings.push(
        `BRAND WARNING: ${cardPath} exists but ${sitePath} is missing "card": "custom". `
          + "Bake infers custom from the file, but set the flag in "
          + `${sitePath} per ${skillPath} so identity is explicit.`,
      );
    }
  } else if (hasCanvas) {
    warnings.push(
      `BRAND WARNING: this looks like a game/canvas app but ${workspaceRoot}/public/og.jpg `
        + "is missing. Games and visually rich apps must ship a custom 1200x630 share card "
        + "built from the app's own art — the default og.grok.me placeholder card is not "
        + `acceptable for them. You are not done: open ${skillPath} and finish the `
        + "brand-asset pass.",
    );
  } else if (cardRequired) {
    warnings.push(
      `BRAND WARNING: ${workspaceRoot}/public/og.jpg is missing and this pass exists to `
        + "produce it. Generate the 1200x630 card from the app's own art and hand it over "
        + `per ${skillPath}. If no image-generation tool is available in this session, `
        + "report that instead of reporting a pass — the app keeps the og.grok.me "
        + "placeholder.",
    );
  } else {
    warnings.push(
      "BRAND NOTE: no custom public/og.jpg — the platform will serve the og.grok.me placeholder. "
        + "Custom cards are the default for games of every kind (DOM board/word games included), "
        + "whimsical apps, creative tools, and brand-forward pages — only plain utilities "
        + "(converters, CRUD trackers, admin dashboards) keep the placeholder. If this app "
        + `is not a plain utility, finish the brand-asset pass per ${skillPath}.`,
    );
  }

  if (hasCanvas && !siteDeclaresOgTypeGame(site)) {
    warnings.push(
      'BRAND WARNING: this looks like a game/canvas app but src/lib/og/site.json is missing '
        + '"type": "x:game". X uses og:type=x:game to present the unfurl as a game card — set '
        + `it in ${sitePath} per ${skillPath}. Do not invent `
        + "x:type or overload twitter:card as the game signal.",
    );
  }

  // Играм со своей карточкой ссылки нужна ещё карточка ленты X 50:11.
  // Пропускаем, пока всё ещё плейсхолдер og.grok.me — этот проход ещё не начался.
  if (hasCanvas && cardPath !== undefined) {
    const bannerPath = join(workspaceRoot, "public/x-banner.jpg");
    if (!existsSync(bannerPath)) {
      warnings.push(
        `BRAND WARNING: this looks like a game/canvas app but ${bannerPath} is missing. `
          + "Games need a 50:11 X feed card (1200×264 JPEG) at public/x-banner.jpg — "
          + `open ${skillPath} and finish the brand-asset pass.`,
      );
    } else if (statSync(bannerPath).size > MAX_CARD_BYTES) {
      warnings.push(
        `BRAND WARNING: ${bannerPath} is over 600 KB — link scrapers (X card previews `
          + "included) time out or skip images this heavy, so the feed card silently fails "
          + `to unfurl. Re-encode as JPEG (ffmpeg -q:v 4) per ${skillPath}.`,
      );
    }
  }

  return warnings;
}

export function parseBrandCheckArgs(argv) {
  const usage =
    "usage: node scripts/brand-check.mjs [--game] [--placeholder-ok] [--root <dir>]";
  let game = false;
  let placeholderOk = false;
  let root = null;
  for (let i = 0; i < argv.length; i += 1) {
    // --game гоняет проверки, которые browser-smoke.mjs выводит из настоящего <canvas>;
    // DOM-играм на доске и словам они тоже нужны, а canvas для детекта нет.
    if (argv[i] === "--game") {
      game = true;
    } else if (argv[i] === "--placeholder-ok") {
      placeholderOk = true;
    } else if (argv[i] === "--root") {
      root = argv[++i];
      if (root === undefined) return { error: `--root needs a directory — ${usage}` };
    } else {
      return { error: `unexpected argument: ${argv[i]} — ${usage}` };
    }
  }
  return { game, placeholderOk, root };
}

function isBrandWarning(message) {
  return message.startsWith("BRAND WARNING:");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseBrandCheckArgs(process.argv.slice(2));
  if (args.error) {
    console.error(JSON.stringify({ ok: false, error: args.error }, null, 2));
    process.exit(1);
  }
  const workspaceRoot = args.root ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  // Вызывающий здесь — задача бренда, проверяющая свою работу: она держит
  // маркер (сообщить о нём, но судить ассеты на диске) и должна свою карточку,
  // рисует приложение на canvas или нет — если только её не запустили для
  // простой утилиты, которая оставляет плейсхолдер, о чём знает только она.
  const messages = brandWarningsOnDisk({
    hasCanvas: args.game,
    workspaceRoot,
    cardRequired: !args.placeholderOk,
  });
  const warnings = messages.filter(isBrandWarning);
  console.log(
    JSON.stringify(
      {
        ok: warnings.length === 0,
        workspaceRoot,
        pending: ogPendingActive(workspaceRoot),
        warnings: warnings.length,
        messages,
      },
      null,
      2,
    ),
  );
  process.exitCode = warnings.length === 0 ? 0 : 1;
}
