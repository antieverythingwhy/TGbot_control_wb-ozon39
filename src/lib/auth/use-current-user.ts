import { useMemo } from "react";
import { authClient, authEnabled } from "./client";

/** Нормализованная форма пользователя, используемая по всему приложению, auth включён или нет. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
  /** Истина, когда это запасной sandbox/dev-пользователь (auth не настроен). */
  isDevFallback: boolean;
};

/**
 * Стабильный запасной пользователь, используется ТОЛЬКО когда auth выключен
 * (`VITE_AUTH_ENABLED=false`, значение по умолчанию в поставке). Когда auth включён, live preview
 * песочницы делает настоящий вход через вшитый preview-клиент. Его id —
 * `"dev-user"` — ТОТ ЖЕ id, который `verify.server.ts` возвращает на сервере — поэтому строки
 * на пользователя, записанные в этом режиме, принадлежат одному согласованному владельцу.
 */
export const DEV_USER: AppUser = {
  id: "dev-user",
  displayName: "Dev User",
  primaryEmail: "dev@example.com",
  profileImageUrl: null,
  isDevFallback: true,
};

/** Результат `useCurrentUserState()`: пользователь плюс флаг загрузки сессии. */
export type CurrentUserState = {
  /** Пользователь — `null` И пока сессия грузится, И когда не вошли. */
  user: AppUser | null;
  /** Истина, пока сессия ещё разрешается — не считайте `user: null` выходом. */
  isPending: boolean;
};

const DEV_STATE: CurrentUserState = { user: DEV_USER, isPending: false };

/**
 * Текущий пользователь + состояние загрузки. Одинаковое поведение в live preview и при деплое:
 *   - Auth включён -> настоящий вошедший пользователь; `user` равен `null`, пока
 *                            сессия разрешается (`isPending: true`) и когда
 *                            не вошли (`isPending: false`). Сессия приходит из
 *                            Better Auth `useSession()` → `/api/auth/get-session`
 *                            (cookie при деплое; bearer в live preview).
 *   - Auth выключен (`VITE_AUTH_ENABLED=false`) -> `DEV_USER`, никогда не pending.
 *
 * Защищайте маршрут, дождавшись окончания `isPending`, прежде чем действовать по `user` —
 * редирект только по `user: null` отбрасывает вошедших посетителей на вход при
 * каждой жёсткой перезагрузке:
 *
 *   import { RedirectToSignIn } from "@/lib/auth/gates";
 *   const { user, isPending } = useCurrentUserState();
 *   if (isPending) return null;              // ещё разрешается — пока не редиректить
 *   if (!user) return <RedirectToSignIn />;  // точно не вошли
 *
 * `authEnabled` — константа уровня модуля, зафиксированная при загрузке, поэтому охраняемый вызов хука
 * сохраняет стабильный порядок хуков на каждом рендере данного компонента.
 */
export function useCurrentUserState(): CurrentUserState {
  if (!authEnabled) return DEV_STATE;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- authEnabled постоянен на всё время жизни приложения
  return useSessionUserState();
}

function useSessionUserState(): CurrentUserState {
  const { data, isPending } = authClient.useSession();
  const id = data?.user.id;
  const displayName = data?.user.name ?? null;
  const primaryEmail = data?.user.email ?? null;
  const profileImageUrl = data?.user.image ?? null;
  const user = useMemo<AppUser | null>(
    () => (id ? { id, displayName, primaryEmail, profileImageUrl, isDevFallback: false } : null),
    [id, displayName, primaryEmail, profileImageUrl],
  );
  return useMemo(() => ({ user, isPending }), [user, isPending]);
}

/**
 * Удобный вид `useCurrentUserState().user` для отображения (напр.
 * `user?.displayName ?? "Guest"`). ЗАМЕЧАНИЕ: `null` значит *загрузка ИЛИ не вошли* —
 * для редиректов/гардов используйте `useCurrentUserState()` и проверяйте `isPending`.
 */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
