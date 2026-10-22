import { genericOAuthClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { runPreSignInSignOut, runSignOut } from "../../../scripts/sign-out-plan.mjs";
import { GROK_PROVIDERS } from "./providers";

/**
 * Клиент Better Auth для этого React SPA (на стороне браузера).
 *
 * Обращается к СОБСТВЕННОМУ Better Auth этого приложения по same-origin `/api/auth/*`. В live
 * preview приложение — встроенный iframe с РАЗДЕЛЁННЫМИ (partitioned) cookie, поэтому после
 * входа через popup оно не может прочитать cookie сессии — вместо этого аутентифицируется
 * bearer-токеном (полученным из popup, см. `signIn`). Хук `onRequest`
 * подставляет этот токен, когда он есть; при деплое (аутентификация по cookie) токен
 * не сохраняется, так что ничего не меняется.
 *
 * Для выхода вызывайте `signOut()` ниже, а НЕ `authClient.signOut()`: сырой вызов
 * оставляет bearer-токен на месте, и `onRequest` продолжает его подставлять, поэтому
 * посетитель остаётся вошедшим.
 */
export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
  fetchOptions: {
    onRequest(ctx) {
      const token = getBearerToken();
      if (token) ctx.headers.set("Authorization", `Bearer ${token}`);
      return ctx;
    },
  },
});

/**
 * Истина, когда нужно показывать UI входа — то есть когда `VITE_AUTH_ENABLED` не
 * равен `"false"`. В поставленном шаблоне он равен `"false"`
 * (`.grok/app-env.json`), что выбирает dev-пользователя (см. `use-current-user`);
 * если ключ убран, вход настоящий и в preview (вшитый preview-клиент), и
 * при деплое (внедрённый клиент на приложение).
 */
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";

/** Провайдеры upstream, для которых рисуются кнопки входа. */
export { GROK_PROVIDERS };

// ── Bearer-токен live-preview ────────────────────────────────────────────────
// У встроенного iframe preview cookie разделены (partitioned), поэтому bearer-токен
// сессии храним в sessionStorage и прикрепляем его к каждому запросу Better Auth (и
// к server functions через `@/lib/auth/middleware`). Пусто везде, кроме
// preview после входа через popup, так что путь через cookie в остальных местах не затронут.
const BEARER_KEY = "grok-auth.bearer-token";

/** Сохранённый bearer-токен preview или null. */
export function getBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

function setBearerToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.sessionStorage.setItem(BEARER_KEY, token);
    else window.sessionStorage.removeItem(BEARER_KEY);
  } catch {
    /* хранилище недоступно — игнорируем */
  }
}

/**
 * Live preview песочницы запускает это приложение внутри iframe на хосте
 * `*.grok-sandbox.com`, где полностраничный редирект к брокеру не сработает —
 * поэтому вход там идёт через popup, а везде остальное — обычным редиректом.
 */
function inLivePreview(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(".grok-sandbox.com")
  );
}

/** Сообщение, которое popup отправляет opener'у, когда вход завершён. */
type PopupMessage = { source: "grok-auth-popup"; token: string | null; error?: string };

/**
 * Начать вход через одного upstream-провайдера (`providerId` из `GROK_PROVIDERS`),
 * федерация через брокер аутентификации Grok.
 *
 * - **Live preview** (iframe `*.grok-sandbox.com`): открывает POPUP на
 *   `/auth/popup`, который отдаёт плагин Vite шаблона (см. `vite.config.ts` +
 *   `popup.server.ts`) — 302 на страницу входа брокера/upstream (без хрома приложения) и,
 *   по возвращении, отправляет bearer-токен сессии обратно. Мы его сохраняем и обновляем
 *   сессию; iframe не делает top-level навигацию к брокеру.
 * - **Задеплоено** (и локально без iframe): обычный полностраничный редирект в брокер.
 *
 * В любом случае сначала очищается существующая локальная сессия, чтобы смена провайдера
 * действительно меняла личность.
 */
export async function signIn(
  providerId: string,
  opts: { callbackURL?: string; errorCallbackURL?: string } = {},
): Promise<void> {
  const callbackURL = opts.callbackURL ?? "/";
  const errorCallbackURL = opts.errorCallbackURL ?? "/";

  // Открываем popup СИНХРОННО на жесте пользователя — до любого await
  // (включая signOut). Await до этого в некоторых
  // браузерах снимает привилегию user-gesture, когда opener — cross-origin iframe live-preview.
  const popup = inLivePreview() ? openSignInPopup(providerId) : null;

  // Очищаем любую предыдущую сессию, чтобы смена провайдера действительно меняла личность.
  // Ограничено по времени, потому что popup уже открыт — запрос, который никогда не завершится,
  // оставил бы его висеть — но ограничение СВОЁ ДЛЯ КАЖДОГО ОКРУЖЕНИЯ: только сервер может
  // завершить задеплоенную сессию, поэтому обрыв на 1.5 с preview
  // начал бы OAuth, пока старая сессия ещё жива.
  await runPreSignInSignOut({
    livePreview: inLivePreview(),
    hasBearer: Boolean(getBearerToken()),
    requestSignOut: () => authClient.signOut(),
    clearToken: () => setBearerToken(null),
  });

  if (inLivePreview()) {
    if (!popup) throw new Error("Pop-up blocked — allow pop-ups for sign-in");
    const token = await waitForPopupToken(popup);
    if (!token) throw new Error("Sign-in was cancelled or failed");
    setBearerToken(token);
    // Обновляем клиентское хранилище сессии с прикреплённым bearer (onRequest).
    // Избегаем полной перезагрузки iframe, если мы уже на нужной странице — эта
    // перезагрузка ощущалась как долгое «всё ещё загружается после закрытия popup».
    try {
      await authClient.getSession();
    } catch {
      /* хранилище сессии восстановится при следующем fetch useSession */
    }
    if (typeof window !== "undefined") {
      const dest = new URL(callbackURL, window.location.origin);
      const here = window.location;
      if (dest.origin !== here.origin || dest.pathname !== here.pathname || dest.search !== here.search) {
        window.location.href = callbackURL;
      }
    }
    return;
  }

  const { data, error } = await authClient.signIn.oauth2({
    providerId,
    callbackURL,
    errorCallbackURL,
  });
  if (error) throw new Error(error.message ?? "Sign-in failed");
  if (data?.url) window.location.href = data.url;
}

/**
 * Открыть `/auth/popup` в новом окне. Должно выполняться синхронно внутри обработчика
 * клика (никакого await до этого). Путь отдаёт плагин Vite шаблона
 * (`authPopupPlugin` в vite.config.ts) — НЕ React-маршрут.
 *
 * Открывает настоящий URL напрямую (не about:blank → assign). Из cross-origin
 * iframe трюк с about:blank часто срывается на первом клике, и окно
 * в итоге показывает оболочку приложения.
 */
function openSignInPopup(providerId: string): Window | null {
  const origin = window.location.origin;
  const url = `${origin}/auth/popup?providerId=${encodeURIComponent(providerId)}`;
  // Уникальное имя на каждую попытку, чтобы не переиспользовать предыдущую попытку, застрявшую на SPA.
  const name = `grok-signin-${Date.now()}`;
  return window.open(url, name, "popup,width=500,height=650");
}

/**
 * Ждать, пока страница завершения popup отправит postMessage с bearer сессии (или
 * пока пользователь закроет popup).
 */
function waitForPopupToken(popup: Window): Promise<string | null> {
  return new Promise((resolve) => {
    const origin = window.location.origin;
    let settled = false;
    let closeTimer: number | undefined;
    const settle = (token: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(token);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = event.data as PopupMessage | undefined;
      if (!data || data.source !== "grok-auth-popup") return;
      settle(data.token ?? null);
    };
    // Запасной путь, когда пользователь закрывает popup. Льготный период даёт
    // postMessage страницы завершения выиграть гонку с `popup.closed`.
    const pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(pollTimer);
      closeTimer = window.setTimeout(() => settle(null), 400);
    }, 300);
    function cleanup() {
      window.clearInterval(pollTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
    }
    window.addEventListener("message", onMessage);
  });
}

/**
 * Выйти из локальной сессии ЭТОГО приложения, очистить токен preview, затем сделать редирект.
 *
 * Используйте это, а не `authClient.signOut()` — см. примечание у `authClient`.
 * Порядок шагов живёт в `scripts/sign-out-plan.mjs`, чтобы его можно было покрыть юнит-тестами.
 *
 * **Отклоняет промис при деплое, если сервер так и не подтвердил.** Там сессия —
 * только HttpOnly cookie, которую может очистить лишь сервер, поэтому редирект всё равно
 * сообщил бы о выходе, которого не было. `<UserButton />` обрабатывает это за вас;
 * самодельный контрол должен поймать ошибку и дать посетителю повторить. В live
 * preview достаточно локальной очистки, поэтому промис всегда резолвится.
 */
export async function signOut(redirectTo = "/"): Promise<void> {
  await runSignOut({
    livePreview: inLivePreview(),
    hasBearer: Boolean(getBearerToken()),
    // Better Auth резолвится с `{ error }`, а не отклоняет промис, поэтому неудачный
    // ответ поднимаем как rejection, чтобы последовательность могла на него среагировать.
    requestSignOut: async () => {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Sign-out failed");
    },
    clearToken: () => setBearerToken(null),
    redirect: () => {
      window.location.href = redirectTo;
    },
  });
}
