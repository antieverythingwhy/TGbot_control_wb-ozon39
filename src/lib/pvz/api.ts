// Вызовы кабинета. Клиент не передаёт роль и не выбирает чужой профиль — сервер берёт его из сессии.
import { createServerFn } from "@tanstack/react-start";
import type { Staff } from "./types";
import { withStaff } from "./middleware";

function readRpc(input: unknown): { action: string; payload: Record<string, unknown> } {
  if (!input || typeof input !== "object") throw new Error("Некорректный запрос");
  const action = (input as { action?: unknown }).action;
  const payload = (input as { payload?: unknown }).payload;
  if (typeof action !== "string" || action.length < 1 || action.length > 40) {
    throw new Error("Некорректный запрос");
  }
  if (payload != null && typeof payload !== "object") throw new Error("Некорректный запрос");
  return { action, payload: (payload ?? {}) as Record<string, unknown> };
}

export const rpc = createServerFn({ method: "POST" })
  .middleware([withStaff])
  .validator(readRpc)
  .handler(async ({ data, context }) => {
    const { handle } = await import("./actions.server");
    const staff = (context as { staff: Staff }).staff;
    return handle(staff, data.action, data.payload);
  });

export const loginFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const username = (input as { username?: unknown })?.username;
    if (typeof username !== "string") throw new Error("Укажите Telegram ID");
    return { username };
  })
  .handler(async ({ data }) => {
    const { login } = await import("./actions.server");
    return login(data.username);
  });

export const loginTelegramFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const initData = (input as { initData?: unknown })?.initData;
    if (typeof initData !== "string" || initData.length < 10 || initData.length > 8000) {
      throw new Error("Нет данных Telegram");
    }
    return { initData };
  })
  .handler(async ({ data }) => {
    const { loginTelegram } = await import("./actions.server");
    return loginTelegram(data.initData);
  });

export const logoutFn = createServerFn({ method: "POST" })
  .middleware([withStaff])
  .handler(async ({ context }) => {
    const { logout } = await import("./actions.server");
    const staff = (context as { staff: Staff }).staff;
    return logout(staff.id);
  });

export async function call<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const result = await rpc({ data: { action, payload: payload ?? {} } });
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}
