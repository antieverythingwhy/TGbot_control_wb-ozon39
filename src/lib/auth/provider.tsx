import type { ReactNode } from "react";

/**
 * Общеприложенческий клиентский провайдер, смонтированный один раз у корня (в `src/routes/__root.tsx`):
 *
 *   <AuthProvider><Outlet /></AuthProvider>
 *
 * React-клиенту Better Auth (`@/lib/auth/client`) НЕ нужен context-провайдер —
 * его `useSession()` работает сам по себе — поэтому сегодня это сквозной проброс. Он
 * оставлен как единственная стабильная точка монтирования для любых будущих клиентских провайдеров
 * (напр. провайдер тостов или темы) без перетряхивания корневой оболочки.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
