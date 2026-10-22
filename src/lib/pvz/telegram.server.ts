// Бот Telegram. Этот файл серверный: ключ не импортируется из экранов.
// Уведомления кабинета дублируются в личный чат, если человек нажал /start
// и его юзернейм уже есть в staff. Чужому бот не пишет.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import { roleLabel, type Role } from "./types";
import { syncOwner } from "./owner.server";

/** Ключ BotFather. Меняется только здесь. В браузер не попадает. */
const TELEGRAM_BOT_TOKEN = "8800516900:AAFsrxJQEF67kOQvHYeWOwHyesuWZRUCV78";

/** Секрет входящего вебхука. Telegram присылает его в заголовке, чужой POST отбрасывается. */
const TELEGRAM_WEBHOOK_SECRET = "pvz_wh_4c8e1a6d9b2740f3a5c8e71d0b6a92f4";

type TgUser = { id?: number; username?: string; first_name?: string };
type TgMessage = {
  text?: string;
  chat?: { id?: number; type?: string };
  from?: TgUser;
};
type TgUpdate = { update_id?: number; message?: TgMessage };

const globalRef = globalThis as {
  __pvzTgPoll?: boolean;
  __pvzTgConfig?: Promise<void> | undefined;
};

function esc(value: string): string {
  return value.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

async function api(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { ok?: boolean; result?: unknown; description?: string; error_code?: number };
  if (!data.ok) {
    throw new Error(`${method} ${data.error_code ?? ""} ${data.description ?? "ошибка Telegram"}`.trim());
  }
  return data.result;
}

/** Команды и описание бота. Повторный вызов безопасен. */
export function armTelegram() {
  if (!globalRef.__pvzTgConfig) {
    globalRef.__pvzTgConfig = configure().catch((error: unknown) => {
      globalRef.__pvzTgConfig = undefined;
      console.error("telegram config", error instanceof Error ? error.message : "fail");
    });
  }
  if (process.env.NODE_ENV === "production") return;
  if (globalRef.__pvzTgPoll) return;
  globalRef.__pvzTgPoll = true;
  void pollLoop();
}

async function configure() {
  const me = (await api("getMe", {})) as { username?: string };
  if (me.username) {
    const sql = await getSql();
    await sql`insert into app_flags (key, value) values ('bot-username', ${me.username})
      on conflict (key) do update set value = ${me.username}`;
  }
  await api("setMyCommands", {
    commands: [
      { command: "start", description: "Привязать уведомления" },
      { command: "whoami", description: "Кто я в кабинете" },
    ],
  });
  await api("setMyDescription", {
    description:
      "Кабинет пунктов выдачи. Сюда приходят смены, открытие, закрытие и остальные рабочие сообщения. Бот пишет только тем, кого уже добавили.",
  });
  await api("setMyShortDescription", {
    short_description: "Смены и отчёты пунктов выдачи",
  });
}

async function pollLoop() {
  let offset = 0;
  try {
    const sql = await getSql();
    const saved = await sql<{ value: string }>`select value from app_flags where key = 'tg-offset'`;
    offset = Number(saved[0]?.value ?? 0) || 0;
  } catch (error) {
    console.error("telegram offset", error instanceof Error ? error.message : "fail");
  }
  for (;;) {
    try {
      const updates = (await api("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      })) as TgUpdate[];
      const sql = await getSql();
      for (const update of updates) {
        if (typeof update.update_id === "number") offset = update.update_id + 1;
        try {
          await handleUpdate(sql, update);
        } catch (error) {
          console.error("telegram update", error instanceof Error ? error.message : "fail");
        }
      }
      await sql`insert into app_flags (key, value) values ('tg-offset', ${String(offset)})
        on conflict (key) do update set value = ${String(offset)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("409")) {
        console.error("telegram poll stopped: webhook is active");
        return;
      }
      console.error("telegram poll", message || "fail");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export async function ingestTelegramRequest(request: Request): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 401 });
  try {
    const update = (await request.json()) as TgUpdate;
    const sql = await getSql();
    await handleUpdate(sql, update);
  } catch (error) {
    console.error("telegram webhook", error instanceof Error ? error.message : "fail");
  }
  return Response.json({ ok: true });
}

async function handleUpdate(sql: Sql, update: TgUpdate) {
  const message = update.message;
  const chat = message?.chat;
  if (!chat || chat.type !== "private" || chat.id == null) return;
  await syncOwner(sql);
  const chatId = String(chat.id);
  const command = (message.text ?? "").trim().split(/[\s@]/)[0]?.toLowerCase() ?? "";
  const username = message.from?.username?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  if (!username || !/^[a-z][a-z0-9_]{4,31}$/.test(username)) {
    await reply(chatId, "У аккаунта нет юзернейма. Откройте Настройки → Имя пользователя, задайте его и снова отправьте /start. Кабинет узнаёт людей только так.");
    return;
  }
  const rows = await sql<{ id: string; name: string; role: string; active: boolean | string }>`
    select id, name, role, active from staff where telegram_username = ${username}`;
  const person = rows[0];
  const active = person && person.active !== false && person.active !== "f" && person.active !== "false";
  if (!person || !active) {
    await reply(
      chatId,
      `@${username} нет в списке. Добавить человека может руководитель или главный администратор: в кабинете, в поле Telegram ID, указывается этот юзернейм.`,
    );
    return;
  }
  await sql`update staff set telegram_chat_id = ${chatId} where id = ${person.id}`;
  const role = roleLabel(person.role as Role);
  if (command === "/whoami") {
    await reply(chatId, `${person.name}\nРоль: ${role}\nЮзернейм: @${username}\nУведомления в этот чат включены.`);
    return;
  }
  if (command === "/start" || command === "") {
    await reply(
      chatId,
      `Здравствуйте, ${person.name}. Роль: ${role}.\nУведомления о сменах, открытии, закрытии и остальных действиях теперь приходят сюда.\nКнопка «Кабинет» слева от поля ввода появится после того, как главный администратор подключит адрес мини-приложения.`,
    );
    return;
  }
  await reply(chatId, "Кабинет на связи. Рабочие сообщения приходят сами. Команда /whoami показывает вашу роль, /start привязывает чат заново.");
}

async function reply(chatId: string, text: string) {
  await api("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
}

export async function pushTelegram(recipientIds: string[], title: string, body: string) {
  try {
    const sql = await getSql();
    const text = `<b>${esc(title)}</b>\n${esc(body)}`.slice(0, 4000);
    for (const id of [...new Set(recipientIds)]) {
      const rows = await sql<{ telegram_chat_id: string | null }>`
        select telegram_chat_id from staff where id = ${id} and active = true`;
      const chatId = rows[0]?.telegram_chat_id;
      if (!chatId) continue;
      try {
        await api("sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } catch (error) {
        console.error("telegram send", error instanceof Error ? error.message : "fail");
      }
    }
  } catch (error) {
    console.error("telegram", error instanceof Error ? error.message : "fail");
  }
}

export async function pushTelegramFile(
  recipientIds: string[],
  caption: string,
  file: { filename: string; base64: string },
) {
  try {
    const sql = await getSql();
    const bytes = Buffer.from(file.base64, "base64");
    for (const id of [...new Set(recipientIds)]) {
      const rows = await sql<{ telegram_chat_id: string | null }>`
        select telegram_chat_id from staff where id = ${id} and active = true`;
      const chatId = rows[0]?.telegram_chat_id;
      if (!chatId) continue;
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", caption.slice(0, 1000));
      form.set(
        "document",
        new File([bytes], file.filename, {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as { ok?: boolean; description?: string };
      if (!data.ok) console.error("telegram file", data.description ?? "fail");
    }
  } catch (error) {
    console.error("telegram file", error instanceof Error ? error.message : "fail");
  }
}

/** Вебхук и кнопка «Кабинет». Адрес — уже опубликованный https-сайт кабинета. */
export async function bindMiniApp(origin: string) {
  await api("setWebhook", {
    url: `${origin}/api/telegram`,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  await api("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Кабинет", web_app: { url: origin } },
  });
}

/** Проверка подписи мини-приложения. Бросает Error с текстом для человека. */
export function readWebAppUser(initData: string): { username: string; chatId: string } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  if (!hash) throw new Error("Telegram не передал подпись. Откройте кабинет из бота.");
  const lines: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") lines.push(`${key}=${value}`);
  }
  lines.sort();
  const secret = hmac(Buffer.from("WebAppData"), Buffer.from(TELEGRAM_BOT_TOKEN));
  const calc = hmac(secret, Buffer.from(lines.join("\n"))).toString("hex");
  const left = Buffer.from(calc);
  const right = Buffer.from(hash);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("Подпись Telegram не сошлась. Откройте кабинет из бота ещё раз.");
  }
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86_400) {
    throw new Error("Сессия Telegram устарела. Закройте кабинет и откройте его из бота снова.");
  }
  let user: TgUser = {};
  try {
    user = JSON.parse(params.get("user") ?? "{}") as TgUser;
  } catch {
    user = {};
  }
  const username = user.username?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(username) || user.id == null) {
    throw new Error("Включите юзернейм в Telegram и откройте кабинет из бота снова.");
  }
  return { username, chatId: String(user.id) };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
