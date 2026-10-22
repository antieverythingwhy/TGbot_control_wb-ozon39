// @ts-check
/**
 * Последовательность выхода, которой пользуется `src/lib/auth/client.ts`, вынесена сюда чистым
 * модулем, чтобы её эффекты можно было юнит-тестировать (`node --test` покрывает только
 * `scripts/`), тем же разделением, что `migration-plan.mjs` для двух применяющих.
 *
 * Две среды аутентифицируются по-разному, поэтому им нужны разные
 * ответы на «сервер не ответил»:
 *
 * - **Live-превью** — партиционированный iframe без читаемой cookie сессии;
 *   сессия едет на bearer-токене в `sessionStorage`. Сброс этого токена
 *   И ЕСТЬ выход, поэтому вызов сервера — best effort, и зависший запрос
 *   никогда не должен оставить кнопку. Именно здесь и бывает зависание.
 * - **Задеплоено** — сессия едет на HttpOnly-cookie `__Host-`, которую JS
 *   не может удалить. ТОЛЬКО завершённый ответ выхода её снимает, и
 *   `server.ts` включает `session.cookieCache` (maxAge 300), поэтому `/get-session`
 *   ещё минуты отвечал бы из закешированной cookie.
 *   Редирект по таймауту показал бы посетителю «вышли», пока сессия
 *   ещё жива — поэтому здесь падаем громко, а не притворяемся.
 */

/**
 * Live-превью: агрессивно, потому что локальный сброс и выводит пользователя.
 * Тот же origin POST обычно отвечает за десятки мс; ниже начали бы
 * бросать медленные, но рабочие выходы без выигрыша.
 */
export const PREVIEW_SIGN_OUT_TIMEOUT_MS = 1500;

/**
 * Задеплоено: щедро, потому что только сервер может закончить эту сессию — но всё же
 * с пределом, чтобы зависший запрос сообщил провал, который посетитель может повторить, а не
 * крутился вечно. Выход без ответа за 10 с уже не придёт.
 */
export const DEPLOYED_SIGN_OUT_TIMEOUT_MS = 10_000;

/**
 * Сколько ждать выход в этой среде. Каждый сетевой вызов выхода
 * берёт свой предел здесь, поэтому разделение превью/деплой не может разъехаться
 * между вызывающими.
 * @param {boolean} livePreview
 * @returns {number}
 */
export function signOutTimeoutMs(livePreview) {
  return livePreview ? PREVIEW_SIGN_OUT_TIMEOUT_MS : DEPLOYED_SIGN_OUT_TIMEOUT_MS;
}

/**
 * Запустить `start()`, но сдаться после `timeoutMs`, сообщив, что случилось. Никогда
 * не reject — вызывающие решают, что значит провал, а `try/catch` вокруг
 * `await` ничего не делает с промисом, который никогда не резолвится.
 * @param {() => unknown} start
 * @param {number} timeoutMs
 * @returns {Promise<"ok" | "failed" | "timeout">}
 */
export function settleWithin(start, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    /** @param {"ok" | "failed"} outcome */
    const done = (outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      Promise.resolve(start()).then(
        () => done("ok"),
        () => done("failed"),
      );
    } catch {
      done("failed");
    }
  });
}

/**
 * @typedef {object} SignOutSteps
 * @property {boolean} livePreview Является ли приложение iframe превью песочницы.
 * @property {boolean} hasBearer Хранится ли bearer-токен превью.
 * @property {() => unknown} requestSignOut Попросить сервер закончить сессию; должен reject при неудачном ответе.
 * @property {() => void} clearToken Сбросить сохранённый bearer-токен.
 * @property {() => void} redirect Уйти со страницы.
 * @property {number} [timeoutMs]
 */

/**
 * Закончить сессию, затем сбросить локальный токен и сделать редирект.
 *
 * В live-превью последние два шага выполняются всегда. На деплое — только если
 * сервер подтвердил, потому что больше ничто не снимет cookie: неудачный или
 * просроченный выход бросает, а не сообщает о выходе, которого не
 * было.
 * @param {SignOutSteps} steps
 * @returns {Promise<void>}
 */
export async function runSignOut({
  livePreview,
  hasBearer,
  requestSignOut,
  clearToken,
  redirect,
  timeoutMs,
}) {
  if (livePreview) {
    // Нет bearer — партиционированный iframe, инвалидировать нечего; если есть,
    // всё равно инвалидируем на сервере, просто не блокируемся на ответе.
    if (hasBearer) {
      await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
    }
    clearToken();
    redirect();
    return;
  }

  const outcome = await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
  if (outcome !== "ok") {
    throw new Error(
      outcome === "timeout"
        ? "Sign-out timed out — you are still signed in. Please try again."
        : "Sign-out failed — you are still signed in. Please try again.",
    );
  }
  clearToken();
  redirect();
}

/**
 * @typedef {object} PreSignInSteps
 * @property {boolean} livePreview Является ли приложение iframe превью песочницы.
 * @property {boolean} hasBearer Хранится ли bearer-токен превью.
 * @property {() => unknown} requestSignOut Попросить сервер закончить любую предыдущую сессию.
 * @property {() => void} clearToken Сбросить сохранённый bearer-токен.
 * @property {number} [timeoutMs]
 */

/**
 * Сбросить любую предыдущую сессию до начала нового входа, чтобы смена провайдера
 * реально меняла личность.
 *
 * Нарочно BEST EFFORT — в отличие от `runSignOut` это никогда не бросает. Оно также
 * выполняется, когда предыдущей сессии нет вовсе, поэтому считать провал фатальным
 * заблокировало бы первый вход из-за сбоя транспорта у посетителя, чью
 * сессию нечего защищать. Дальнейший OAuth-поток выдаёт свежую сессию в любом
 * случае. Ограничено только ожидание, и тем же правилом на среду, что и
 * `runSignOut`: задеплоенная сессия умирает на сервере, поэтому получает полное
 * окно, а не агрессивное окно превью.
 * @param {PreSignInSteps} steps
 * @returns {Promise<void>}
 */
export async function runPreSignInSignOut({
  livePreview,
  hasBearer,
  requestSignOut,
  clearToken,
  timeoutMs,
}) {
  // В превью отсутствие bearer значит, что сбрасывать нечего.
  if (hasBearer || !livePreview) {
    await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
  }
  clearToken();
}
