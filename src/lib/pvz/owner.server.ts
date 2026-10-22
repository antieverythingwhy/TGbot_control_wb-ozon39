// Подтягивает роль главного администратора к константе из owner.ts.
// Вызывается на сервере перед любым действием. Из кабинета обойти нельзя.
import type { Sql } from "@/lib/db";
import { BOT_OWNER_NAME, configuredOwnerUsername } from "./owner";

export async function syncOwner(sql: Sql) {
  const username = configuredOwnerUsername();
  if (!username) {
    await sql`update staff set role = 'director' where role = 'owner'`;
    return;
  }
  const rows = await sql<{ id: string; role: string; active: boolean | string }>`
    select id, role, active from staff where telegram_username = ${username}`;
  const mine = rows[0];
  if (!mine) {
    await sql`insert into staff (id, name, role, telegram_username, phone, active)
      values (${crypto.randomUUID()}, ${BOT_OWNER_NAME}, 'owner', ${username}, '', true)`;
  } else if (mine.role !== "owner" || mine.active === false || mine.active === "f" || mine.active === "false") {
    await sql`update staff set role = 'owner', active = true where id = ${mine.id}`;
  }
  // Кто угодно с ролью owner, но другим юзернеймом, больше не главный.
  await sql`update staff set role = 'director' where role = 'owner' and telegram_username <> ${username}`;
  const id = mine?.id
    ?? (await sql<{ id: string }>`select id from staff where telegram_username = ${username}`)[0]?.id;
  if (id) await sql`delete from staff_points where staff_id = ${id}`;
}
