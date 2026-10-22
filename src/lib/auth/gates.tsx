import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn, signOut } from "./client";
import { hasGateSessionMarker } from "./gate-session-marker";
import { resolveSignInGateState } from "./sign-in-gate";
import { useCurrentUser, useCurrentUserState } from "./use-current-user";

const subscribeToNothing = () => () => {};
const noGateSessionOnServer = () => false;

/**
 * Компоненты состояния аутентификации — простые обёртки вокруг `useCurrentUserState()`.
 *
 * Когда auth включён, посетители не вошли, пока не аутентифицируются — в том числе в
 * live preview песочницы, где вход настоящий. Общий dev-пользователь появляется только
 * когда auth выключен (`VITE_AUTH_ENABLED=false`, значение по умолчанию в поставке).
 * Пока сессия ещё разрешается, гейты, которым важно состояние «не вошёл»,
 * ничего не рендерят, чтобы при жёсткой перезагрузке не мигало «не вошёл».
 */

/** Куда `RedirectToSignIn` отправляет невошедших посетителей. Создайте этот маршрут. */
export const SIGN_IN_PATH = "/login";

/** Рендерить children только когда пользователь есть (реальная сессия или dev-пользователь при выключенном auth). */
export function SignedIn({ children }: { children: ReactNode }) {
  const { user } = useCurrentUserState();
  return user ? <>{children}</> : null;
}

/**
 * Рендерить children только когда мы ТОЧНО знаем, что посетитель не вошёл (`isPending`
 * уже сброшен и пользователя нет). Скрыто, пока сессия ещё загружается.
 */
export function SignedOut({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending || user) return null;
  return <>{children}</>;
}

/**
 * Клиентский редирект на маршрут входа (TanStack `<Navigate>` — НЕ полная
 * перезагрузка `window.location`). Жёсткая навигация заново поднимает SPA и снова запускает
 * загрузку сессии, что ощущается как второй «Loading…» на /login.
 *
 * Защищайте маршруты, сначала дождавшись окончания `isPending` (см. `use-current-user`), затем
 * рендерьте это.
 */
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) {
  return <Navigate to={to} />;
}

export function SignInGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { user, isPending } = useCurrentUserState();
  const state = resolveSignInGateState({ isPending, hasUser: user !== null });
  if (state === "pending") return null;
  if (state === "signed_in") return <>{children}</>;
  return <>{fallback ?? <SignInButtons />}</>;
}

export function SignInButtons() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {GROK_PROVIDERS.map((p) => (
        <button
          key={p.providerId}
          type="button"
          onClick={() => signIn(p.providerId, { callbackURL: "/" })}
          className="w-full cursor-pointer rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Continue with {p.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Минимальный чип личности вошедшего пользователя + выход. Стилизуйте свободно (см.
 * skill `design-ui`). Выход показывается только когда auth включён (у
 * dev-пользователя при выключенном auth не из чего выходить) и сессия не
 * материализована gate — за gate следующий запрос сразу же снова входит
 * зрителя, так что кнопка выхода там — сломанный цикл.
 */
export function UserButton() {
  const user = useCurrentUser();
  // Выход может занять мгновение (и может не удаться при деплое), поэтому контрол
  // показывает, что работает, и его нельзя нажать дважды.
  const [signingOut, setSigningOut] = useState(false);
  const gateSession = useSyncExternalStore(
    subscribeToNothing,
    hasGateSessionMarker,
    noGateSessionOnServer,
  );
  if (!user) return null;
  const label = user.displayName ?? user.primaryEmail ?? "Account";
  return (
    <div className="flex items-center gap-2">
      {user.profileImageUrl ? (
        <img
          src={user.profileImageUrl}
          alt=""
          className="h-8 w-8 rounded-full object-cover"
        />
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-black/10 text-sm font-medium dark:bg-white/20">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-sm font-medium">{label}</span>
      {authEnabled && !gateSession && (
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            // Успех уводит со страницы; при ошибке снова включаем, чтобы можно было повторить.
            void signOut().catch(() => setSigningOut(false));
          }}
          className="cursor-pointer text-sm underline-offset-4 opacity-70 hover:underline disabled:cursor-wait disabled:no-underline"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      )}
    </div>
  );
}
