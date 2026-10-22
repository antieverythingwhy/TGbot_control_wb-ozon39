// Сессия приглашённого сотрудника. Токен из браузера, сверка только на сервере.
import { createMiddleware } from "@tanstack/react-start";
import type { Staff } from "./types";

export const withStaff = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    let sessionToken: string | undefined;
    try {
      sessionToken = localStorage.getItem("pvz.token") ?? undefined;
    } catch {
      sessionToken = undefined;
    }
    return next({ sendContext: { sessionToken } });
  })
  .server(async ({ next, context }) => {
    const { getCookie } = await import("@tanstack/react-start/server");
    const { resolveStaff } = await import("./actions.server");
    const sent = (context as { sessionToken?: string }).sessionToken;
    const staff = await resolveStaff(sent || getCookie("pvz_session"));
    if (!staff) throw new Error("Войдите по приглашению");
    return next({ context: { staff } });
  });

export type StaffContext = { staff: Staff };
