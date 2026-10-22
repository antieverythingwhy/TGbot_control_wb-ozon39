// Будильник. Раз в минуту внешний сайт открывает этот адрес, и сервер рассылает напоминания.
// Без секретного заголовка запрос отвергается.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/cron")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { cronAuthorized } = await import("@/lib/pvz/cron.server");
        if (!cronAuthorized(request)) return new Response("forbidden", { status: 401 });
        const { runReminders } = await import("@/lib/pvz/actions.server");
        await runReminders();
        return Response.json({ ok: true });
      },
    },
  },
});
