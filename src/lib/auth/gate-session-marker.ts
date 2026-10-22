/**
 * Клиентски читаемый маркер сессий, материализованных gate («Sign in with Grok» —
 * сессии без клика, выпущенные `gate-session.server.ts`). Выход из
 * gate-сессии ничего не делает (no-op): следующий запрос заново материализует её из
 * `x-grok-identity`, поэтому `UserButton` по этому маркеру прячет кнопку выхода.
 * С префиксом `__Host-`, как и остальные auth-cookie: браузеры отклоняют cookie `__Host-`
 * с атрибутом `Domain`, так что недоверенное соседнее приложение `*.grok.me` не может
 * подложить копию на родительском домене, которую host-only очистка никогда не смогла бы протухнуть.
 * Безопасно для клиента: нет серверных импортов.
 */
export const GATE_SESSION_MARKER_COOKIE = "__Host-grok_gate_session";

export function hasGateSessionMarker(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((pair) => pair.trim().startsWith(`${GATE_SESSION_MARKER_COOKIE}=`));
}
