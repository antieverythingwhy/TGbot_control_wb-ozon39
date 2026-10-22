// Вход бота. GET только будит приём сообщений в превью. POST принимает вебхук Telegram.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/telegram")({
  server: {
    handlers: {
      GET: async () => {
        const { armTelegram } = await import("@/lib/pvz/telegram.server");
        armTelegram();
        return Response.json({ ok: true });
      },
      POST: async ({ request }) => {
        const { ingestTelegramRequest } = await import("@/lib/pvz/telegram.server");
        return ingestTelegramRequest(request);
      },
    },
  },
});
