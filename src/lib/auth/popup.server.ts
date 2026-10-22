/**
 * Popup входа live-preview — только сервер (НИКОГДА не импортируйте с клиента).
 *
 * Preview песочницы запускает приложение в разделённом iframe, поэтому OAuth должен происходить
 * в top-level popup (first-party cookie). Этот обработчик — ВЕСЬ документ
 * popup, без React-оболочки:
 *
 *   Фаза 1 (`?providerId=…`): начать OAuth на сервере и сразу 302 на
 *     страницу входа брокера / upstream. Popup никогда не рисует приложение.
 *   Фаза 2 (`?done=1`): после круга к брокеру отдать крошечную HTML-страницу, которая
 *     отправляет токен сессии opener'у и закрывается. Без гидрации SPA и без
 *     кругового запроса к server function.
 *
 * Подключается автоматически плагином Vite `authPopupPlugin` в `vite.config.ts` во время
 * `npm run dev` (live preview). НЕ создавайте `src/routes/auth/popup.tsx` —
 * React-маршрут здесь рисует полную оболочку приложения в popup. Opener живёт в
 * `client.ts` (`signIn` → `openSignInPopup`).
 */
import { auth, SESSION_TOKEN_COOKIE } from "./server";

/** Форма сообщения, которое popup отправляет opener'у (должна совпадать с `client.ts`). */
type PopupMessage = {
  source: "grok-auth-popup";
  token: string | null;
  error?: string;
};

/**
 * Обработать `GET /auth/popup`. Вызывается плагином Vite `authPopupPlugin` (dev / live
 * preview). Не реэкспортируйте это из файла React-маршрута.
 */
export async function handleAuthPopupRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const done = url.searchParams.get("done") === "1";

  if (done) {
    const errored = url.searchParams.has("error");
    const token = errored ? null : readCookie(request, SESSION_TOKEN_COOKIE);
    const message: PopupMessage = {
      source: "grok-auth-popup",
      token,
      ...(errored ? { error: url.searchParams.get("error") ?? "sign_in_failed" } : {}),
    };
    return new Response(completionHtml(message), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Никогда не кэшировать страницу, в которую встроен токен сессии.
        "cache-control": "no-store",
      },
    });
  }

  const providerId = url.searchParams.get("providerId")?.trim();
  if (!providerId) {
    return new Response("Missing providerId", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Оставаться first-party для callback, чтобы cookie сессии легла в ЭТОТ popup.
  const back = `${url.origin}/auth/popup?done=1`;
  try {
    const apiRes = await auth.api.signInWithOAuth2({
      body: {
        providerId,
        callbackURL: back,
        errorCallbackURL: `${back}&error=1`,
      },
      // Передать хост preview, чтобы Better Auth вывел правильный baseURL /
      // redirect_uri для динамического origin `*.grok-sandbox.com`.
      headers: request.headers,
      asResponse: true,
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => "");
      return completionResponse({
        source: "grok-auth-popup",
        token: null,
        error: detail || `oauth_init_failed_${apiRes.status}`,
      });
    }

    const body = (await apiRes.json().catch(() => null)) as {
      url?: string;
    } | null;
    const location = body?.url;
    if (!location) {
      return completionResponse({
        source: "grok-auth-popup",
        token: null,
        error: "oauth_init_missing_url",
      });
    }

    // 302 к брокеру (который без UI пересылает на Google/X). Переслать любые
    // Set-Cookie (состояние OAuth / PKCE), чтобы callback мог завершиться в этом popup.
    const headers = new Headers({ location, "cache-control": "no-store" });
    for (const cookie of apiRes.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, { status: 302, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "oauth_init_threw";
    return completionResponse({
      source: "grok-auth-popup",
      token: null,
      error: message,
    });
  }
}

function completionResponse(message: PopupMessage): Response {
  return new Response(completionHtml(message), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Минимальный HTML: postMessage токена opener'у и закрытие. Без React. */
function completionHtml(message: PopupMessage): string {
  // JSON безопасен внутри блока <script type="application/json">; встроенный
  // скрипт только читает его. Это обходит ловушки экранирования при встраивании в исходник JS.
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signing in…</title>
<style>
  html,body{margin:0;min-height:100%;background:#0b0b0c;color:#a1a1aa;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{min-height:100vh;display:grid;place-items:center;padding:1.5rem;text-align:center}
</style>
</head>
<body>
<main><p>Signing you in…</p></main>
<script type="application/json" id="grok-auth-popup-msg">${payload}</script>
<script>
(function () {
  var el = document.getElementById("grok-auth-popup-msg");
  var msg = { source: "grok-auth-popup", token: null };
  try { if (el && el.textContent) msg = JSON.parse(el.textContent); } catch (e) {}
  try {
    if (window.opener) window.opener.postMessage(msg, window.location.origin);
  } catch (e) {}
  try { window.close(); } catch (e) {}
})();
</script>
</body>
</html>`;
}

/** Прочитать одно значение cookie из запроса (учитывает `=` внутри значений). */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
