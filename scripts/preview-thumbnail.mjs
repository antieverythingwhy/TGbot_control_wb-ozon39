#!/usr/bin/env node
// Снять PNG превью 1280x800 dev-сервера (argv[2] -> argv[3]).
// Контракт с SandboxInternal.CapturePreviewThumbnail: exit 0 только после того, как
// PNG записан; сервис считает любой ненулевой код контролируемым пропуском и
// не скачивает файл.
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

// Сервис всегда передаёт loopback-URL и путь в /tmp; проверки сохраняют это
// верным и когда скрипт запускают вручную.
const url = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const outPng = checkedOutputPath(process.argv[3] || "/tmp/preview-thumbnail.png", [
  "/tmp",
  "/workspace",
]);
const timeoutMs = Number(process.env.PREVIEW_THUMBNAIL_TIMEOUT_MS || 45000);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // `domcontentloaded`, не `networkidle`: Vite держит открытым websocket HMR, поэтому
  // networkidle никогда не наступает и сжёг бы весь таймаут.
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const status = resp?.status() ?? 0;
  await page.waitForTimeout(1000);

  await page.screenshot({ path: outPng, fullPage: false });

  console.log(JSON.stringify({ url, status, screenshot: outPng }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, url, error: String(err?.message || err) }, null, 2));
  // Ставим код, а не process.exit(), чтобы разбор браузера в `finally`
  // всегда выполнялся (не течёт Chromium при повторных вызовах захвата).
  process.exitCode = 1;
} finally {
  await browser.close();
}
