// Серверная логика кабинета.
// Права:
//   сотрудник              — свои смены, чек-листы, проблемы, пожелания, замены, заказ хозтоваров;
//   администратор          — все пункты, график, сотрудники (без удаления и без смены роли);
//   руководитель           — то же плюс удаление сотрудников и администраторов, пункты сети, поставки и журнал Excel;
//   главный администратор  — всё это плюс назначение руководителя и администратора.
// Роль главного администратора берётся только из owner.ts и в кабинете не передаётся.
// Случайный человек без строки в staff войти не может.

import { getSql, type Sql } from "@/lib/db";
import { configuredOwnerUsername } from "./owner";
import { syncOwner } from "./owner.server";
import { ISSUE_CATEGORIES, itemsFor, PRIORITIES, statusLabel, ZONES } from "./catalog";
import {
  addDays,
  atShift,
  dayOfMonth,
  monthISO,
  nextMonth,
  openTone,
  ruDay,
  ruStamp,
  todayISO,
} from "./time";
import type {
  Answer,
  Checklist,
  Delivery,
  IssueRow,
  Notice,
  PrefBatch,
  PrefDay,
  Replacement,
  Role,
  RunBrief,
  Shift,
  Staff,
  SupplyDraft,
  SupplyItem,
  SupplyReport,
  Workspace,
  CheckTemplate,
} from "./types";

class Biz extends Error {}

type Row = Record<string, unknown>;

function flag(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

function text(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function dayOf(v: unknown): string {
  const raw = text(v);
  return raw.slice(0, 10);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function must(v: unknown, message: string, max: number): string {
  const value = str(v, max);
  if (!value) throw new Biz(message);
  return value;
}

/** Поле подписано «Telegram ID», но принимается только юзернейм. */
function normalizeUsername(raw: string): string {
  const username = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(username)) {
    throw new Biz("В поле Telegram ID укажите юзернейм, например @ivan_petrov");
  }
  return username;
}

function asRole(v: unknown): Role {
  if (v === "manager" || v === "director" || v === "employee" || v === "owner") return v;
  return "employee";
}

function checkPhoto(value: string): string {
  if (!value) return "";
  if (!value.startsWith("data:image/jpeg") || !value.includes("base64,")) {
    throw new Biz("Нужна фотография в формате JPEG");
  }
  if (value.length > 500_000) throw new Biz("Фото слишком большое. Снимите ближе или ещё раз.");
  return value;
}

function parseItems(raw: unknown): SupplyItem[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const quantity = text(row.quantity).trim();
      if (!quantity) return [];
      return [
        {
          good: text(row.good),
          name: text(row.name),
          unit: text(row.unit),
          quantity,
        },
      ];
    });
  } catch {
    return [];
  }
}

async function loadStaff(sql: Sql, id: string): Promise<Staff | null> {
  const rows = await sql<Row>`select * from staff where id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  const role = asRole(row.role);
  let pointIds: string[] = [];
  if (role === "employee") {
    const links = await sql<{ point_id: string }>`select point_id from staff_points where staff_id = ${id}`;
    pointIds = links.map((link) => link.point_id);
  } else {
    const points = await sql<{ id: string }>`select id from points where active = true order by sort`;
    pointIds = points.map((point) => point.id);
  }
  return {
    id: text(row.id),
    name: text(row.name),
    role,
    username: text(row.telegram_username),
    phone: text(row.phone),
    active: flag(row.active),
    pointIds,
    botLinked: text(row.telegram_chat_id).length > 0,
  };
}

function mapShift(row: Row): Shift {
  return {
    id: text(row.id),
    day: dayOf(row.day),
    pointId: text(row.point_id),
    staffId: text(row.staff_id),
    start: text(row.start_time).slice(0, 5),
    end: text(row.end_time).slice(0, 5),
    published: flag(row.published),
    confirmed: flag(row.confirmed),
    overlapReason: text(row.overlap_reason),
  };
}

async function leaderIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }>`select id from staff where active = true and role in ('manager', 'director', 'owner')`;
  return rows.map((row) => row.id);
}

async function directorIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }>`select id from staff where active = true and role in ('director', 'owner')`;
  return rows.map((row) => row.id);
}

/** Письмо в кабинет и, если чат привязан, в Telegram. dedupe не даёт послать одно и то же дважды. */
async function notify(
  sql: Sql,
  recipients: string[],
  kind: string,
  title: string,
  body: string,
  dedupePrefix?: string,
  telegram: boolean = true,
): Promise<string[]> {
  const ids = [...new Set(recipients)].filter(Boolean);
  const fresh: string[] = [];
  for (const id of ids) {
    const dedupe = dedupePrefix ? `${dedupePrefix}:${id}` : crypto.randomUUID();
    const inserted = await sql<{ recipient_id: string }>`insert into notifications (id, recipient_id, kind, title, body, dedupe_key)
      values (${crypto.randomUUID()}, ${id}, ${kind}, ${title}, ${body}, ${dedupe})
      on conflict (dedupe_key) do nothing
      returning recipient_id`;
    if (inserted.length) fresh.push(id);
  }
  if (telegram && fresh.length) {
    const { pushTelegram } = await import("./telegram.server");
    await pushTelegram(fresh, title, body);
  }
  return fresh;
}

async function pointName(sql: Sql, id: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from points where id = ${id}`;
  return rows[0]?.name ?? id;
}

async function personName(sql: Sql, id: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from staff where id = ${id}`;
  return rows[0]?.name ?? "Сотрудник";
}

/** Напоминания накануне, за час и сообщение, если смену не открыли. Журнал отдельно не плодится: он один и собирается из базы по кнопке. */
async function sweep(sql: Sql) {
  const now = Date.now();
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const leaders = await leaderIds(sql);
  const shifts = await sql<Row>`select * from shifts where published = true`;
  const runs = await sql<Row>`select shift_id, type, finished_at from checklist_runs`;
  const opened = new Set(
    runs.filter((run) => text(run.type) === "opening" && run.finished_at).map((run) => text(run.shift_id)),
  );
  for (const row of shifts) {
    const shift = mapShift(row);
    const start = atShift(shift.day, shift.start);
    const who = await personName(sql, shift.staffId);
    const where = await pointName(sql, shift.pointId);
    const label = `${ruDay(shift.day)}, ${shift.start}–${shift.end}, ${where}`;
    if (shift.day === tomorrow && now < start) {
      await notify(
        sql,
        [shift.staffId],
        "remind-day",
        "Смена завтра",
        `Напоминание: завтра у вас смена ${label}.`,
        `remind24:${shift.id}`,
      );
    }
    if (shift.day === today && now >= start - 3_600_000 && now < start) {
      await notify(
        sql,
        [shift.staffId],
        "remind-hour",
        "Смена через час",
        `Напоминание: через час начало вашей смены ${label}.`,
        `remind1:${shift.id}`,
      );
    }
    if (now >= start + 15 * 60_000 && !opened.has(shift.id) && shift.day <= today) {
      await notify(
        sql,
        leaders,
        "late",
        "Смена не открыта",
        `${who} не открыл смену на точке ${where}. С момента назначенного времени ${shift.start} (${ruDay(shift.day)}) прошло больше 15 минут.`,
        `late:${shift.id}`,
      );
    }
  }
}

const globalRef = globalThis as { __pvzSweep?: boolean };

function armSweep() {
  if (globalRef.__pvzSweep) return;
  globalRef.__pvzSweep = true;
  setInterval(() => {
    void (async () => {
      try {
        const sql = await getSql();
        await sweep(sql);
      } catch (error) {
        console.error(error);
      }
    })();
  }, 60_000);
}

async function maintain(sql: Sql) {
  await syncOwner(sql);
  await sweep(sql);
  armSweep();
  const { armTelegram } = await import("./telegram.server");
  armTelegram();
}

/** Напоминания по расписанию. Вызывает будильник /api/cron, даже если кабинет никто не открывал. */
export async function runReminders() {
  const sql = await getSql();
  await sweep(sql);
}

function assertLeader(staff: Staff) {
  if (staff.role === "employee") throw new Biz("Раздел доступен администратору и руководителю");
}

function assertDirector(staff: Staff) {
  if (staff.role !== "director" && staff.role !== "owner") {
    throw new Biz("Это может сделать руководитель или главный администратор");
  }
}

function assertPoint(staff: Staff, pointId: string) {
  if (!staff.pointIds.includes(pointId)) throw new Biz("Нет доступа к этому пункту");
}

async function getShift(sql: Sql, id: string): Promise<Shift> {
  const rows = await sql<Row>`select * from shifts where id = ${id}`;
  if (!rows[0]) throw new Biz("Смена не найдена");
  return mapShift(rows[0]);
}

function assertOwnOrLeader(staff: Staff, shift: Shift) {
  assertPoint(staff, shift.pointId);
  if (staff.role === "employee" && shift.staffId !== staff.id) throw new Biz("Это не ваша смена");
}

function canEdit(staff: Staff, shift: Shift, type: "opening" | "closing", finished: boolean, now = Date.now()) {
  if (finished) return false;
  if (staff.role !== "employee") return true;
  if (shift.staffId !== staff.id || !shift.published) return false;
  const start = atShift(shift.day, shift.start);
  const end = atShift(shift.day, shift.end);
  if (type === "opening") return now >= start - 2 * 60 * 60_000;
  return now >= end;
}

function lockReason(staff: Staff, shift: Shift, type: "opening" | "closing", finished: boolean): string {
  if (finished) return "Отчёт завершён. Исправление доступно администратору через историю.";
  if (staff.role !== "employee") return "";
  if (!shift.published) return "Смена ещё не опубликована.";
  if (shift.staffId !== staff.id) return "Это не ваша смена.";
  const now = Date.now();
  if (type === "opening" && now < atShift(shift.day, shift.start) - 2 * 60 * 60_000) {
    return "Открытие доступно за 2 часа до начала смены.";
  }
  if (type === "closing" && now < atShift(shift.day, shift.end)) {
    return "Закрытие доступно с окончания смены. Администратор может сдать её раньше.";
  }
  return "";
}

async function checkItems(sql: Sql, type: "opening" | "closing"): Promise<CheckTemplate[]> {
  const any = await sql`select id from checklist_items where type = ${type} limit 1`;
  const rows = await sql<Row>`select * from checklist_items where type = ${type} and active = true order by sort, text`;
  if (any.length) {
    return rows.map((row) => ({
      id: text(row.id),
      type,
      text: text(row.text),
      kind: text(row.kind),
      sort: Number(row.sort),
    }));
  }
  return itemsFor(type).map((item, index) => ({ id: item.id, type, text: item.text, kind: item.kind, sort: index + 1 }));
}

async function ensureRun(sql: Sql, shiftId: string, type: "opening" | "closing") {
  const existing = await sql<Row>`select * from checklist_runs where shift_id = ${shiftId} and type = ${type}`;
  if (existing[0]) return existing[0];
  const items = await checkItems(sql, type);
  if (!items.length) throw new Biz("Руководитель ещё не добавил пункты чек-листа");
  const id = crypto.randomUUID();
  await sql`insert into checklist_runs (id, shift_id, type) values (${id}, ${shiftId}, ${type})`;
  for (const item of items) {
    await sql`insert into checklist_answers (run_id, item_id, item_text, kind, sort)
      values (${id}, ${item.id}, ${item.text}, ${item.kind}, ${item.sort})`;
  }
  const created = await sql<Row>`select * from checklist_runs where id = ${id}`;
  return created[0];
}

async function answersOf(sql: Sql, runId: string): Promise<Answer[]> {
  const rows = await sql<Row>`select * from checklist_answers where run_id = ${runId} order by sort, item_id`;
  return rows.map((row) => ({
    itemId: text(row.item_id),
    text: text(row.item_text),
    kind: text(row.kind),
    status: text(row.status),
    comment: text(row.comment),
    priority: text(row.priority),
    photo: text(row.photo),
  }));
}

function reportBody(
  verb: string,
  actor: string,
  employee: string,
  where: string,
  shift: Shift,
  answers: Answer[],
): string {
  const head =
    actor === employee
      ? `${employee} ${verb} на точке ${where}.`
      : `${actor} ${verb} сотрудника ${employee} на точке ${where}.`;
  const lines = answers
    .map((answer) => {
      const extra = answer.comment ? ` — ${answer.comment}` : "";
      const priority = answer.status === "problem" && answer.priority ? ` (${answer.priority})` : "";
      return `• ${answer.text}: ${statusLabel(answer.status)}${priority}${extra}`;
    })
    .join("\n");
  return `${head}\nДата: ${ruDay(shift.day)}, смена ${shift.start}–${shift.end}.\n${lines}`;
}

async function workspace(sql: Sql, me: Staff): Promise<Workspace> {
  const peopleRows = await sql<Row>`select * from staff order by name`;
  const people: Staff[] = [];
  for (const row of peopleRows) {
    const person = await loadStaff(sql, text(row.id));
    if (person) people.push(person);
  }
  const visiblePeople =
    me.role === "employee"
      ? people.filter(
          (person) =>
            person.active &&
            (person.id === me.id ||
              person.role !== "employee" ||
              person.pointIds.some((id) => me.pointIds.includes(id))),
        )
      : people;
  const pointRows = await sql<Row>`select * from points where active = true order by sort`;
  const points = pointRows
    .filter((row) => me.pointIds.includes(text(row.id)))
    .map((row) => ({
      id: text(row.id),
      name: text(row.name),
      sort: Number(row.sort),
      opens: text(row.opens_at).slice(0, 5) || "09:00",
      closes: text(row.closes_at).slice(0, 5) || "21:00",
    }));
  const shiftRows = await sql<Row>`select * from shifts order by day, start_time`;
  const shifts = shiftRows.map(mapShift).filter((shift) => {
    if (!me.pointIds.includes(shift.pointId)) return false;
    if (me.role === "employee" && !shift.published) return false;
    return true;
  });
  const shiftIds = new Set(shifts.map((shift) => shift.id));
  const runRows = await sql<Row>`select id, shift_id, type, started_at, finished_at, finished_by from checklist_runs`;
  const runs: RunBrief[] = [];
  for (const row of runRows) {
    if (!shiftIds.has(text(row.shift_id))) continue;
    const problems = await sql<{ n: number }>`select count(*)::int as n from checklist_answers
      where run_id = ${text(row.id)} and status = 'problem'`;
    runs.push({
      shiftId: text(row.shift_id),
      type: text(row.type) === "closing" ? "closing" : "opening",
      startedAt: row.started_at ? text(row.started_at) : null,
      finishedAt: row.finished_at ? text(row.finished_at) : null,
      finishedBy: row.finished_by ? text(row.finished_by) : null,
      problems: Number(problems[0]?.n ?? 0),
    });
  }
  const issueRows = await sql<Row>`select id, point_id, staff_id, category, body, priority, status, resolution, photo, created_at
    from issues order by created_at desc limit 80`;
  const issues: IssueRow[] = issueRows
    .filter((row) => me.pointIds.includes(text(row.point_id)) && (me.role !== "employee" || text(row.staff_id) === me.id))
    .map((row) => ({
      id: text(row.id),
      pointId: text(row.point_id),
      staffId: text(row.staff_id),
      category: text(row.category),
      body: text(row.body),
      priority: text(row.priority),
      status: text(row.status),
      resolution: text(row.resolution),
      hasPhoto: text(row.photo).length > 0,
      createdAt: text(row.created_at),
    }));
  const noticeRows = await sql<Row>`select * from notifications where recipient_id = ${me.id} order by created_at desc limit 80`;
  const notices: Notice[] = noticeRows.map((row) => ({
    id: text(row.id),
    kind: text(row.kind),
    title: text(row.title),
    body: text(row.body),
    read: flag(row.read),
    createdAt: text(row.created_at),
  }));
  const replRows = await sql<Row>`select * from replacements order by created_at desc`;
  const replacements: Replacement[] = replRows
    .filter((row) => {
      if (!me.pointIds.includes(text(row.point_id))) return false;
      if (me.role !== "employee") return true;
      return text(row.requester_id) === me.id || me.pointIds.includes(text(row.point_id));
    })
    .map((row) => ({
      id: text(row.id),
      shiftId: text(row.shift_id),
      pointId: text(row.point_id),
      day: dayOf(row.day),
      requesterId: text(row.requester_id),
      reason: text(row.reason),
      comment: text(row.comment),
      status: text(row.status),
      replacementId: row.replacement_id ? text(row.replacement_id) : null,
      counterShiftId: row.counter_shift_id ? text(row.counter_shift_id) : null,
    }));
  const prefRows = await sql<Row>`select * from preferences`;
  const batchRows = await sql<Row>`select * from preference_batches`;
  const buckets = new Map<string, PrefBatch>();
  for (const row of batchRows) {
    const staffId = text(row.staff_id);
    if (me.role === "employee" && staffId !== me.id) continue;
    const month = text(row.month);
    buckets.set(`${staffId}:${month}`, { staffId, month, sent: flag(row.sent), days: [] });
  }
  for (const row of prefRows) {
    const staffId = text(row.staff_id);
    if (me.role === "employee" && staffId !== me.id) continue;
    const month = text(row.month);
    const key = `${staffId}:${month}`;
    const batch = buckets.get(key) ?? { staffId, month, sent: false, days: [] };
    const day: PrefDay = { day: Number(row.day), status: text(row.status), comment: text(row.comment) };
    batch.days.push(day);
    buckets.set(key, batch);
  }
  const goodRows = await sql<Row>`select * from supply_goods order by sort`;
  const goods = goodRows.map((row) => ({ id: text(row.id), name: text(row.name), unit: text(row.unit) }));
  const checkRows = await sql<Row>`select * from checklist_items where active = true order by sort, text`;
  const checks: CheckTemplate[] = checkRows.map((row) => ({
    id: text(row.id),
    type: text(row.type) === "closing" ? "closing" : "opening",
    text: text(row.text),
    kind: text(row.kind),
    sort: Number(row.sort),
  }));
  const draftRows = await sql<Row>`select * from supply_drafts`;
  const drafts: SupplyDraft[] = draftRows
    .filter((row) => me.pointIds.includes(text(row.point_id)) && (me.role !== "employee" || text(row.staff_id) === me.id))
    .map((row) => ({
      id: text(row.id),
      pointId: text(row.point_id),
      staffId: text(row.staff_id),
      items: parseItems(row.items_json),
      comment: text(row.comment),
      updatedAt: row.updated_at ? text(row.updated_at) : null,
    }));
  const reportRows = await sql<Row>`select * from supply_reports order by created_at desc`;
  const reports: SupplyReport[] = reportRows
    .filter((row) => me.pointIds.includes(text(row.point_id)) && (me.role !== "employee" || text(row.staff_id) === me.id))
    .map((row) => ({
      id: text(row.id),
      shiftId: text(row.shift_id),
      pointId: text(row.point_id),
      staffId: text(row.staff_id),
      items: parseItems(row.items_json),
      comment: text(row.comment),
      status: text(row.status),
      createdAt: text(row.created_at),
    }));
  const deliveryRows = await sql<Row>`select * from supply_deliveries order by day desc, created_at desc`;
  const deliveries: Delivery[] = deliveryRows
    .filter((row) => me.pointIds.includes(text(row.point_id)))
    .map((row) => ({
      id: text(row.id),
      pointId: text(row.point_id),
      goodId: text(row.good_id),
      name: text(row.name),
      unit: text(row.unit),
      quantity: Number(row.quantity),
      day: dayOf(row.day),
      comment: text(row.comment),
      actorId: text(row.actor_id),
    }));
  const today = todayISO();
  const flags = await sql<{ key: string; value: string }>`select key, value from app_flags where key in ('bot-username', 'mini-app-url')`;
  const flagMap = new Map(flags.map((row) => [row.key, row.value]));
  return {
    me,
    today,
    month: monthISO(),
    nextMonth: nextMonth(monthISO()),
    wishesLocked: dayOfMonth() > 25,
    nowLabel: ruStamp(),
    points,
    people: visiblePeople,
    shifts,
    runs,
    issues,
    notices,
    unread: notices.filter((notice) => !notice.read).length,
    replacements,
    prefs: [...buckets.values()],
    goods,
    checks,
    drafts,
    reports,
    deliveries,
    botUsername: flagMap.get("bot-username") ?? "",
    ownerUsername: configuredOwnerUsername(),
    miniAppUrl: flagMap.get("mini-app-url") ?? "",
    cronSecret: me.role === "owner" ? (await import("./cron.server")).cronSecret() : "",
  };
}

async function checklist(sql: Sql, staff: Staff, payload: Record<string, unknown>): Promise<Checklist> {
  const type = payload.type === "closing" ? "closing" : "opening";
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertOwnOrLeader(staff, shift);
  const run = await ensureRun(sql, shift.id, type);
  const finished = Boolean(run.finished_at);
  const answers = await answersOf(sql, text(run.id));
  const zoneRows = await sql<Row>`select zone, photo from zone_photos where run_id = ${text(run.id)}`;
  const zones = ZONES.map((zone) => ({
    zone,
    photo: text(zoneRows.find((row) => text(row.zone) === zone)?.photo),
  }));
  const historyRows = await sql<Row>`select text, actor_name, created_at from audit_log
    where entity = ${"run:" + text(run.id)} order by created_at desc limit 20`;
  const openingDone =
    type === "opening"
      ? finished
      : Boolean(
          (
            await sql`select finished_at from checklist_runs where shift_id = ${shift.id} and type = 'opening'`
          )[0]?.finished_at,
        );
  const locked = !canEdit(staff, shift, type, finished);
  return {
    shift,
    type,
    locked,
    lockReason: lockReason(staff, shift, type, finished),
    canFinish: !locked,
    startedAt: run.started_at ? text(run.started_at) : null,
    finishedAt: run.finished_at ? text(run.finished_at) : null,
    finishedByName: run.finished_by ? await personName(sql, text(run.finished_by)) : null,
    answers,
    zones,
    history: historyRows.map((row) => ({
      text: text(row.text),
      actor: text(row.actor_name),
      at: text(row.created_at),
    })),
    tone: openTone(shift.day, shift.start, type === "opening" ? finished : openingDone),
  };
}

async function touchRun(sql: Sql, runId: string, staff: Staff) {
  await sql`update checklist_runs set started_at = coalesce(started_at, now()), started_by = coalesce(started_by, ${staff.id})
    where id = ${runId}`;
}

async function saveAnswer(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const type = payload.type === "closing" ? "closing" : "opening";
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertOwnOrLeader(staff, shift);
  const run = await ensureRun(sql, shift.id, type);
  if (run.finished_at || !canEdit(staff, shift, type, false)) throw new Biz(lockReason(staff, shift, type, Boolean(run.finished_at)) || "Правка недоступна");
  const itemId = must(payload.itemId, "Не выбран пункт", 40);
  const status = str(payload.status, 20);
  if (status && !["ok", "problem", "na"].includes(status)) throw new Biz("Неизвестный результат");
  const comment = str(payload.comment, 2000);
  const priority = str(payload.priority, 40);
  if (priority && !PRIORITIES.includes(priority)) throw new Biz("Неизвестный приоритет");
  const current = await sql<Row>`select photo from checklist_answers where run_id = ${text(run.id)} and item_id = ${itemId}`;
  if (!current[0]) throw new Biz("Пункт не найден");
  const photo = typeof payload.photo === "string" ? checkPhoto(payload.photo) : text(current[0].photo);
  await sql`update checklist_answers set status = ${status}, comment = ${comment}, priority = ${priority}, photo = ${photo}
    where run_id = ${text(run.id)} and item_id = ${itemId}`;
  await touchRun(sql, text(run.id), staff);
  return checklist(sql, staff, payload);
}

async function saveZone(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertOwnOrLeader(staff, shift);
  const run = await ensureRun(sql, shift.id, "closing");
  if (run.finished_at || !canEdit(staff, shift, "closing", false)) throw new Biz("Фото зоны сейчас изменить нельзя");
  const zone = must(payload.zone, "Не выбрана зона", 80);
  if (!ZONES.includes(zone)) throw new Biz("Неизвестная зона");
  const photo = checkPhoto(must(payload.photo, "Добавьте фотографию", 500_000));
  await sql`insert into zone_photos (run_id, zone, photo) values (${text(run.id)}, ${zone}, ${photo})
    on conflict (run_id, zone) do update set photo = ${photo}`;
  await touchRun(sql, text(run.id), staff);
  return checklist(sql, staff, { shiftId: shift.id, type: "closing" });
}

async function finish(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const type = payload.type === "closing" ? "closing" : "opening";
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertOwnOrLeader(staff, shift);
  const run = await ensureRun(sql, shift.id, type);
  if (run.finished_at) throw new Biz("Отчёт уже завершён");
  if (!canEdit(staff, shift, type, false)) throw new Biz(lockReason(staff, shift, type, false) || "Рано завершать");
  const answers = await answersOf(sql, text(run.id));
  for (const answer of answers) {
    if (!answer.status) throw new Biz(`Выберите результат: ${answer.text}`);
    if (answer.status === "problem" && (!answer.comment.trim() || !answer.photo || !answer.priority)) {
      throw new Biz(`Для проблемы «${answer.text}» нужны описание, фото и приоритет`);
    }
    if (answer.status === "ok" && answer.kind === "text" && !answer.comment.trim()) {
      throw new Biz(`Напишите комментарий: ${answer.text}. Если вопросов нет — так и укажите.`);
    }
    if (answer.status === "ok" && answer.kind === "photo" && !answer.photo) {
      throw new Biz(`Добавьте фото: ${answer.text}`);
    }
  }
  if (type === "closing") {
    const zones = await sql<Row>`select zone, photo from zone_photos where run_id = ${text(run.id)}`;
    for (const zone of ZONES) {
      const photo = text(zones.find((row) => text(row.zone) === zone)?.photo);
      if (!photo) throw new Biz(`Добавьте фото зоны: ${zone}`);
    }
  }
  await touchRun(sql, text(run.id), staff);
  await sql`update checklist_runs set finished_at = now(), finished_by = ${staff.id} where id = ${text(run.id)}`;
  const where = await pointName(sql, shift.pointId);
  const employee = await personName(sql, shift.staffId);
  const verb = type === "opening" ? "открыл смену" : "закрыл смену";
  let body = reportBody(verb, staff.name, employee, where, shift, answers);
  if (type === "closing") {
    const draftId = shift.id;
    const pendingId = `pending:${shift.pointId}:${shift.staffId}`;
    const drafts = await sql<Row>`select * from supply_drafts where id = ${draftId} or id = ${pendingId}`;
    const merged = new Map<string, SupplyItem>();
    let comment = "";
    for (const draft of drafts) {
      for (const item of parseItems(draft.items_json)) merged.set(item.good, item);
      if (text(draft.comment)) comment = text(draft.comment);
    }
    const items = [...merged.values()];
    if (!(await sql`select id from supply_reports where shift_id = ${shift.id}`).length) {
      await sql`insert into supply_reports (id, shift_id, point_id, staff_id, items_json, comment, status)
        values (${crypto.randomUUID()}, ${shift.id}, ${shift.pointId}, ${shift.staffId}, ${JSON.stringify(items)}, ${comment}, 'Новая')`;
    }
    await sql`delete from supply_drafts where id = ${draftId} or id = ${pendingId}`;
    const goods = items.length
      ? items.map((item) => `${item.name}: ${item.quantity}`).join("; ")
      : "потребность не указана";
    body += `\nХоз. товары: ${goods}.`;
    await notify(sql, await leaderIds(sql), "supply", "Заказ хозтоваров", `${employee}, ${where}. ${goods}`, `supply-report:${shift.id}`);
  }
  for (const answer of answers) {
    if (answer.status !== "problem") continue;
    await sql`insert into issues (id, point_id, staff_id, shift_id, category, body, priority, photo, status)
      values (${crypto.randomUUID()}, ${shift.pointId}, ${shift.staffId}, ${shift.id}, ${"Чек-лист: " + answer.text}, ${answer.comment}, ${answer.priority || "Обычная"}, ${answer.photo}, 'Новая')`;
  }
  await notify(sql, await leaderIds(sql), type, type === "opening" ? "Смена открыта" : "Смена закрыта", body, `${type}:${shift.id}`);
  await sql`insert into audit_log (id, actor_id, actor_name, entity, text)
    values (${crypto.randomUUID()}, ${staff.id}, ${staff.name}, ${"run:" + text(run.id)}, ${"Завершён отчёт: " + verb})`;
  return checklist(sql, staff, payload);
}

async function correct(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const type = payload.type === "closing" ? "closing" : "opening";
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertPoint(staff, shift.pointId);
  const reason = must(payload.reason, "Укажите причину исправления", 500);
  const status = must(payload.status, "Выберите результат", 20);
  if (!["ok", "problem", "na"].includes(status)) throw new Biz("Неизвестный результат");
  const run = await ensureRun(sql, shift.id, type);
  const itemId = must(payload.itemId, "Не выбран пункт", 40);
  await sql`update checklist_answers set status = ${status} where run_id = ${text(run.id)} and item_id = ${itemId}`;
  await sql`insert into audit_log (id, actor_id, actor_name, entity, text)
    values (${crypto.randomUUID()}, ${staff.id}, ${staff.name}, ${"run:" + text(run.id)}, ${"Исправление пункта " + itemId + " → " + statusLabel(status) + ". " + reason})`;
  await notify(
    sql,
    await leaderIds(sql),
    "correct",
    "Исправление отчёта",
    `${staff.name} исправил пункт отчёта по точке ${await pointName(sql, shift.pointId)} (${ruDay(shift.day)}): ${statusLabel(status)}. ${reason}`,
  );
  return checklist(sql, staff, { shiftId: shift.id, type });
}

async function saveShift(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const day = must(payload.day, "Укажите дату", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Biz("Некорректная дата");
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  assertPoint(staff, pointId);
  const staffId = must(payload.staffId, "Выберите сотрудника", 40);
  const start = must(payload.start, "Укажите время открытия", 5);
  const end = must(payload.end, "Укажите время закрытия", 5);
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) {
    throw new Biz("Проверьте время: открытие должно быть раньше закрытия");
  }
  const person = await loadStaff(sql, staffId);
  if (!person || !person.active) throw new Biz("Сотрудник не найден");
  if (person.role === "employee" && !person.pointIds.includes(pointId)) {
    throw new Biz("Сотрудник не закреплён за этим пунктом");
  }
  const reason = str(payload.overlapReason, 500);
  const id = str(payload.id, 80);
  const clash = await sql<Row>`select id from shifts where staff_id = ${staffId} and day = ${day} and id <> ${id || ""}`;
  if (clash.length && !reason) throw new Biz("В этот день у сотрудника уже есть смена. Напишите причину, если её всё равно нужно поставить.");
  if (id) {
    const prev = await getShift(sql, id);
    assertPoint(staff, prev.pointId);
    await sql`update shifts set day = ${day}, point_id = ${pointId}, staff_id = ${staffId}, start_time = ${start}, end_time = ${end}, overlap_reason = ${reason}, confirmed = false where id = ${id}`;
    await notify(sql, [staffId, prev.staffId], "shift", "Смена изменена", `${staff.name} изменил смену: ${ruDay(day)} ${start}–${end}, ${await pointName(sql, pointId)}.`);
    return { id };
  }
  const created = crypto.randomUUID();
  await sql`insert into shifts (id, day, point_id, staff_id, start_time, end_time, published, overlap_reason)
    values (${created}, ${day}, ${pointId}, ${staffId}, ${start}, ${end}, false, ${reason})`;
  return { id: created };
}

async function publishMonth(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const month = must(payload.month, "Выберите месяц", 7);
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  assertPoint(staff, pointId);
  const rows = (await sql<Row>`select * from shifts where point_id = ${pointId} and published = false`).filter((row) =>
    dayOf(row.day).startsWith(month),
  );
  if (!rows.length) return { count: 0 };
  for (const row of rows) {
    const shift = mapShift(row);
    await sql`update shifts set published = true where id = ${shift.id}`;
    await notify(
      sql,
      [shift.staffId],
      "publish",
      "Смена опубликована",
      `Вам назначена смена ${ruDay(shift.day)}, ${shift.start}–${shift.end}, ${await pointName(sql, shift.pointId)}.`,
      `publish:${shift.id}`,
    );
  }
  await notify(sql, await leaderIds(sql), "publish", "График опубликован", `${staff.name} опубликовал график ${month} · ${await pointName(sql, pointId)}.`, `publish-month:${pointId}:${month}:${rows.length}`);
  return { count: rows.length };
}

async function removeShift(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const shift = await getShift(sql, must(payload.id, "Выберите смену", 80));
  assertPoint(staff, shift.pointId);
  const done = await sql`select id from checklist_runs where shift_id = ${shift.id} and finished_at is not null`;
  if (done.length) throw new Biz("По этой смене уже есть завершённый отчёт. Удалять её нельзя.");
  await sql`delete from shifts where id = ${shift.id}`;
  await notify(sql, [shift.staffId], "shift", "Смена снята", `${staff.name} снял смену ${ruDay(shift.day)} ${shift.start}–${shift.end}.`);
  return { id: shift.id };
}

async function selfShift(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  assertPoint(staff, pointId);
  const day = todayISO();
  const existing = await sql<Row>`select * from shifts where staff_id = ${staff.id} and point_id = ${pointId} and day = ${day}`;
  if (existing[0]) return { id: text(existing[0].id) };
  const hours = await pointHours(sql, pointId);
  const id = crypto.randomUUID();
  await sql`insert into shifts (id, day, point_id, staff_id, start_time, end_time, published, overlap_reason)
    values (${id}, ${day}, ${pointId}, ${staff.id}, ${hours.opens}, ${hours.closes}, true, 'Самостоятельный выход')`;
  return { id };
}

function phoneOf(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Biz("Телефон: 7–15 цифр с кодом страны");
  return `+${digits}`;
}

async function saveStaff(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertLeader(actor);
  const name = must(payload.name, "Укажите имя и фамилию", 120).replace(/\s+/g, " ");
  if (name.length < 2) throw new Biz("Укажите имя и фамилию");
  const username = normalizeUsername(must(payload.username, "Укажите Telegram ID", 40));
  const phone = phoneOf(str(payload.phone, 30));
  const id = str(payload.id, 80);
  const existing = id ? await loadStaff(sql, id) : null;
  if (id && !existing) throw new Biz("Сотрудник не найден");
  if (existing?.role === "owner" && actor.role !== "owner" && existing.id !== actor.id) {
    throw new Biz("Главного администратора нельзя изменить из кабинета");
  }
  if (existing?.role === "owner" && username !== existing.username) {
    throw new Biz("Юзернейм главного администратора меняется только в коде бота");
  }
  const reserved = configuredOwnerUsername();
  if (reserved && username === reserved && existing?.role !== "owner") {
    throw new Biz("Этот юзернейм закреплён за главным администратором в коде бота");
  }
  if (actor.role !== "owner") {
    if (existing && existing.role !== "employee" && existing.id !== actor.id) {
      throw new Biz("Чужую роль администратора или руководителя меняет главный администратор");
    }
    if (!existing && payload.role && payload.role !== "employee") {
      throw new Biz("Роль администратора и руководителя назначает главный администратор");
    }
  }
  let role: Role = "employee";
  if (existing?.role === "owner") role = "owner";
  else if (actor.role === "owner") {
    if (payload.role === "owner") throw new Biz("Роль главного администратора назначается только в коде бота");
    if (payload.role === "manager" || payload.role === "director" || payload.role === "employee") role = payload.role;
    else role = existing?.role ?? "employee";
  } else {
    role = existing?.role ?? "employee";
  }
  const pointIds = Array.isArray(payload.pointIds) ? payload.pointIds.filter((item): item is string => typeof item === "string") : [];
  if (role === "employee" && pointIds.length === 0) throw new Biz("Закрепите хотя бы один пункт");
  const taken = await sql`select id from staff where telegram_username = ${username} and id <> ${id || ""}`;
  if (taken.length) throw new Biz("Такой Telegram ID уже указан у другого человека");
  const savedId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await sql`update staff set name = ${name}, role = ${role}, telegram_username = ${username}, phone = ${phone} where id = ${savedId}`;
  } else {
    await sql`insert into staff (id, name, role, telegram_username, phone) values (${savedId}, ${name}, ${role}, ${username}, ${phone})`;
  }
  if (role === "employee") {
    await sql`delete from staff_points where staff_id = ${savedId}`;
    for (const pointId of pointIds) {
      const known = await sql`select id from points where id = ${pointId} and active = true`;
      if (!known.length) throw new Biz("Неизвестный пункт");
      await sql`insert into staff_points (staff_id, point_id) values (${savedId}, ${pointId})`;
    }
  } else {
    await sql`delete from staff_points where staff_id = ${savedId}`;
  }
  await sql`insert into audit_log (id, actor_id, actor_name, entity, text)
    values (${crypto.randomUUID()}, ${actor.id}, ${actor.name}, ${"staff:" + savedId}, ${(existing ? "Изменён: " : "Добавлен: ") + name + " @" + username + " · " + role})`;
  if (!existing) {
    await notify(sql, await leaderIds(sql), "staff", "Новый сотрудник", `${actor.name} добавил ${name} (@${username}). Вход откроется под этим юзернеймом после /start у бота.`);
  }
  return { id: savedId, username };
}

async function deleteStaff(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  if (actor.role !== "director" && actor.role !== "owner") throw new Biz("Недостаточно прав");
  const id = must(payload.id, "Выберите сотрудника", 80);
  if (id === actor.id) throw new Biz("Нельзя удалить свою учётную запись");
  const person = await loadStaff(sql, id);
  if (!person) throw new Biz("Сотрудник не найден");
  if (person.role === "owner") {
    throw new Biz("Главного администратора нельзя удалить из кабинета. Роль снимается только в коде бота.");
  }
  if (actor.role === "director" && person.role !== "employee" && person.role !== "manager") {
    throw new Biz("Руководитель удаляет сотрудников и администраторов. Другого руководителя снимает главный администратор.");
  }
  await sql`update staff set active = false where id = ${id}`;
  await sql`delete from sessions where staff_id = ${id}`;
  await sql`insert into audit_log (id, actor_id, actor_name, entity, text)
    values (${crypto.randomUUID()}, ${actor.id}, ${actor.name}, ${"staff:" + id}, ${"Удалён доступ: " + person.name})`;
  return { id };
}

async function savePoint(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const name = must(payload.name, "Укажите название пункта", 160);
  const id = str(payload.id, 40);
  const opens = clock(payload.opens, "09:00");
  const closes = clock(payload.closes, "21:00");
  if (opens >= closes) throw new Biz("Открытие должно быть раньше закрытия");
  if (id) {
    await sql`update points set name = ${name}, opens_at = ${opens}, closes_at = ${closes} where id = ${id}`;
    const today = todayISO();
    const future = (await sql<Row>`select * from shifts where point_id = ${id}`).filter((row) => dayOf(row.day) >= today);
    for (const row of future) {
      const shift = mapShift(row);
      if (shift.start === opens && shift.end === closes) continue;
      const opened = await sql`select id from checklist_runs where shift_id = ${shift.id} and type = 'opening' and finished_at is not null`;
      if (opened.length) continue;
      await sql`update shifts set start_time = ${opens}, end_time = ${closes} where id = ${shift.id}`;
      if (shift.published) {
        await notify(
          sql,
          [shift.staffId],
          "shift",
          "Время смены изменилось",
          `${actor.name} поставил для пункта «${name}» часы ${opens}–${closes}. Ваша смена ${ruDay(shift.day)} теперь в это время.`,
          `hours:${shift.id}:${opens}:${closes}`,
        );
      }
    }
    return { id };
  }
  const sortRow = await sql<{ n: number }>`select coalesce(max(sort), 0)::int as n from points`;
  const created = crypto.randomUUID();
  await sql`insert into points (id, name, sort, opens_at, closes_at) values (${created}, ${name}, ${Number(sortRow[0]?.n ?? 0) + 1}, ${opens}, ${closes})`;
  await notify(sql, await leaderIds(sql), "point", "Новый пункт", `${actor.name} добавил пункт «${name}», часы ${opens}–${closes}.`);
  return { id: created };
}

function clock(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.slice(0, 5) : "";
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

async function pointHours(sql: Sql, pointId: string): Promise<{ opens: string; closes: string }> {
  const rows = await sql<Row>`select opens_at, closes_at from points where id = ${pointId}`;
  return {
    opens: text(rows[0]?.opens_at).slice(0, 5) || "09:00",
    closes: text(rows[0]?.closes_at).slice(0, 5) || "21:00",
  };
}

async function deletePoint(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const id = must(payload.id, "Выберите пункт", 40);
  const used = await sql<{ n: number }>`select count(*)::int as n from shifts where point_id = ${id}`;
  if (Number(used[0]?.n ?? 0) > 0) throw new Biz("У пункта есть смены. Сначала перенесите или снимите их.");
  await sql`delete from points where id = ${id}`;
  return { id };
}

async function savePrefs(sql: Sql, staff: Staff, payload: Record<string, unknown>, send: boolean) {
  if (staff.role !== "employee") throw new Biz("Пожелания отправляет сотрудник");
  if (dayOfMonth() > 25) throw new Biz("С 26-го числа пожелания закрыты. Изменения вносит администратор.");
  const month = nextMonth(monthISO());
  const days = Array.isArray(payload.days) ? payload.days : [];
  for (const entry of days) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const day = Number(row.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) continue;
    const status = str(row.status, 20);
    const comment = str(row.comment, 300);
    await sql`insert into preferences (staff_id, month, day, status, comment)
      values (${staff.id}, ${month}, ${day}, ${status}, ${comment})
      on conflict (staff_id, month, day) do update set status = ${status}, comment = ${comment}`;
  }
  await sql`insert into preference_batches (staff_id, month, sent) values (${staff.id}, ${month}, ${send})
    on conflict (staff_id, month) do update set sent = ${send}`;
  if (send) {
    await notify(
      sql,
      await leaderIds(sql),
      "prefs",
      "Пожелания по графику",
      `${staff.name} отправил пожелания на ${month}.`,
      `prefs:${staff.id}:${month}:${Date.now()}`,
    );
  }
  return { month, sent: send };
}

async function editPref(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertLeader(actor);
  const staffId = must(payload.staffId, "Выберите сотрудника", 80);
  const month = must(payload.month, "Укажите месяц", 7);
  const day = Number(payload.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Biz("Некорректный день");
  const status = str(payload.status, 20);
  const comment = str(payload.comment, 300);
  await sql`insert into preferences (staff_id, month, day, status, comment)
    values (${staffId}, ${month}, ${day}, ${status}, ${comment})
    on conflict (staff_id, month, day) do update set status = ${status}, comment = ${comment}`;
  await notify(sql, [staffId], "prefs", "Пожелания изменены", `${actor.name} исправил ваши пожелания на ${month}, день ${day}.`);
  return { ok: true };
}

async function createIssue(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  assertPoint(staff, pointId);
  const category = must(payload.category, "Выберите категорию", 80);
  if (!ISSUE_CATEGORIES.includes(category) && !category.startsWith("Чек-лист:")) throw new Biz("Неизвестная категория");
  const body = must(payload.body, "Опишите, что произошло", 2000);
  const priority = must(payload.priority, "Выберите приоритет", 40);
  if (!PRIORITIES.includes(priority)) throw new Biz("Неизвестный приоритет");
  const photo = checkPhoto(must(payload.photo, "Добавьте фотографию", 500_000));
  const id = crypto.randomUUID();
  await sql`insert into issues (id, point_id, staff_id, category, body, priority, photo)
    values (${id}, ${pointId}, ${staff.id}, ${category}, ${body}, ${priority}, ${photo})`;
  const where = await pointName(sql, pointId);
  await notify(
    sql,
    await leaderIds(sql),
    "issue",
    priority === "Критическая" ? "Критическая проблема" : "Новая проблема",
    `${staff.name}, ${where}. ${category}, приоритет «${priority}». ${body}`,
    `issue:${id}`,
  );
  return { id };
}

async function closeIssue(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const id = must(payload.id, "Выберите проблему", 80);
  const resolution = must(payload.resolution, "Напишите, как решили", 500);
  const rows = await sql<Row>`select * from issues where id = ${id}`;
  if (!rows[0]) throw new Biz("Проблема не найдена");
  assertPoint(staff, text(rows[0].point_id));
  await sql`update issues set status = 'Закрыта', resolution = ${resolution} where id = ${id}`;
  await notify(sql, [text(rows[0].staff_id)], "issue", "Проблема закрыта", `${staff.name} закрыл обращение «${text(rows[0].category)}». ${resolution}`);
  return { id };
}

async function issuePhoto(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const id = must(payload.id, "Выберите проблему", 80);
  const rows = await sql<Row>`select point_id, staff_id, photo from issues where id = ${id}`;
  if (!rows[0]) throw new Biz("Проблема не найдена");
  if (staff.role === "employee" && text(rows[0].staff_id) !== staff.id) throw new Biz("Нет доступа");
  assertPoint(staff, text(rows[0].point_id));
  return { photo: text(rows[0].photo) };
}

async function createReplacement(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  if (staff.role === "employee" && shift.staffId !== staff.id) throw new Biz("Можно просить замену только своей смены");
  assertPoint(staff, shift.pointId);
  const colleague = await loadStaff(sql, must(payload.colleagueId, "Выберите коллегу", 80));
  if (!colleague || !colleague.active) throw new Biz("Коллега не найден");
  if (colleague.id === shift.staffId) throw new Biz("Нельзя предложить замену самому себе");
  if (colleague.role !== "employee" || !colleague.pointIds.includes(shift.pointId)) {
    throw new Biz("Коллега должен быть сотрудником этого пункта");
  }
  const reason = must(payload.reason, "Укажите причину", 200);
  const comment = str(payload.comment, 1000);
  const counterId = str(payload.counterShiftId, 80);
  if (counterId) {
    const counter = await getShift(sql, counterId);
    if (counter.staffId !== colleague.id) throw new Biz("Взамен можно отдать только смену этого коллеги");
    if (!staff.pointIds.includes(counter.pointId) && staff.role === "employee") {
      throw new Biz("Вы не закреплены за пунктом этой смены");
    }
  }
  const pending = await sql`select id from replacements where shift_id = ${shift.id} and status = 'На рассмотрении'`;
  if (pending.length) throw new Biz("По этой смене уже есть неотвеченная просьба");
  const id = crypto.randomUUID();
  await sql`insert into replacements (id, shift_id, point_id, day, requester_id, reason, comment, replacement_id, counter_shift_id)
    values (${id}, ${shift.id}, ${shift.pointId}, ${shift.day}, ${shift.staffId}, ${reason}, ${comment}, ${colleague.id}, ${counterId})`;
  const where = await pointName(sql, shift.pointId);
  const swapLine = counterId
    ? " Взамен предлагается отдать его смену."
    : "";
  await notify(
    sql,
    [colleague.id],
    "swap",
    "Вам предлагают замену",
    `${staff.name} предлагает вам смену ${ruDay(shift.day)} ${shift.start}–${shift.end}, ${where}. ${reason}. ${comment}${swapLine} Откройте «График» и нажмите «Согласиться» или «Отказаться».`,
    `swap-ask:${id}`,
  );
  return { id };
}

async function reviewReplacement(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const id = must(payload.id, "Выберите запрос", 80);
  const rows = await sql<Row>`select * from replacements where id = ${id}`;
  if (!rows[0]) throw new Biz("Запрос не найден");
  const request = rows[0];
  const colleagueId = text(request.replacement_id);
  const chief = staff.role === "director" || staff.role === "owner";
  if (staff.id !== colleagueId && !chief && staff.role !== "manager") {
    throw new Biz("Ответить может тот, кому предложили замену, или руководитель");
  }
  if (staff.role === "manager") assertPoint(staff, text(request.point_id));
  if (text(request.status) !== "На рассмотрении") throw new Biz("По этой просьбе уже ответили");
  if (payload.approve !== true) {
    await sql`update replacements set status = 'Отклонена' where id = ${id}`;
    await notify(
      sql,
      [text(request.requester_id), ...(await directorIds(sql))],
      "swap",
      "Замена отклонена",
      `${staff.name} отказался от замены ${ruDay(dayOf(request.day))}. График не изменился.`,
      `swap-no:${id}`,
    );
    return { id };
  }
  const chosen = str(payload.replacementId, 80) || colleagueId;
  if (!chosen) throw new Biz("Выберите, кто выйдет");
  const next = await loadStaff(sql, chosen);
  if (!next || next.role !== "employee" || !next.pointIds.includes(text(request.point_id))) {
    throw new Biz("Сменщик должен быть сотрудником этого пункта");
  }
  const shift = await getShift(sql, text(request.shift_id));
  const counterId = text(request.counter_shift_id);
  const reason = str(payload.reason, 500);
  const requesterId = text(request.requester_id);
  const clashRows = await sql<{ id: string }>`select id from shifts where staff_id = ${chosen} and day = ${shift.day} and id <> ${shift.id}`;
  const clash = clashRows.filter((row) => row.id !== counterId);
  let counter: Shift | null = null;
  if (counterId && chosen === colleagueId) {
    counter = await getShift(sql, counterId);
    const back = await sql`select id from shifts where staff_id = ${requesterId} and day = ${counter.day} and id <> ${counter.id}`;
    if (back.length && !reason) throw new Biz("У того, кто просил замену, уже есть смена в день встречной смены. Пусть руководитель напишет решение.");
  }
  if (clash.length && !reason && !chief) throw new Biz("У коллеги уже есть другая смена в этот день. Пусть руководитель решит.");
  if (clash.length && !reason && chief) throw new Biz("У нового сотрудника уже есть смена в этот день. Напишите решение.");
  await sql`update shifts set staff_id = ${chosen}, confirmed = false, overlap_reason = ${reason} where id = ${shift.id}`;
  let counterLine = "";
  if (counter) {
    await sql`update shifts set staff_id = ${requesterId}, confirmed = false, overlap_reason = ${reason} where id = ${counter.id}`;
    counterLine = ` Взамен ${await personName(sql, requesterId)} выходит ${ruDay(counter.day)} ${counter.start}–${counter.end}.`;
  }
  await sql`update replacements set status = 'Одобрена', replacement_id = ${chosen} where id = ${id}`;
  const where = await pointName(sql, shift.pointId);
  const asker = await personName(sql, requesterId);
  await notify(
    sql,
    [requesterId, chosen, ...(await directorIds(sql))],
    "swap",
    "Замена согласована",
    `${asker} и ${next.name} договорились. График обновлён: ${ruDay(shift.day)} ${shift.start}–${shift.end}, ${where}, теперь выходит ${next.name}.${counterLine}`,
    `swap-ok:${id}`,
  );
  return { id };
}

async function confirmShift(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const shift = await getShift(sql, must(payload.shiftId, "Выберите смену", 80));
  assertOwnOrLeader(staff, shift);
  if (Date.now() < atShift(shift.day, "00:00")) throw new Biz("Подтвердить выход можно в день смены");
  await sql`update shifts set confirmed = true where id = ${shift.id}`;
  await notify(
    sql,
    await leaderIds(sql),
    "confirm",
    "Выход подтверждён",
    `${await personName(sql, shift.staffId)} подтвердил выход ${ruDay(shift.day)} ${shift.start}–${shift.end}, ${await pointName(sql, shift.pointId)}.`,
    `confirm:${shift.id}`,
  );
  return { id: shift.id };
}

async function saveDraft(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  assertPoint(staff, pointId);
  const shiftId = str(payload.shiftId, 80);
  let owner = staff.id;
  if (shiftId) {
    const shift = await getShift(sql, shiftId);
    assertOwnOrLeader(staff, shift);
    if (shift.pointId !== pointId) throw new Biz("Смена относится к другому пункту");
    owner = shift.staffId;
    const closed = await sql`select id from checklist_runs where shift_id = ${shift.id} and type = 'closing' and finished_at is not null`;
    if (closed.length) throw new Biz("Смена уже сдана. Заказ войдёт в следующую.");
  }
  const goods = await sql<Row>`select * from supply_goods`;
  const raw = Array.isArray(payload.items) ? payload.items : [];
  const items: SupplyItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const good = goods.find((item) => text(item.id) === text(row.good));
    if (!good) throw new Biz("Неизвестный товар");
    const quantity = str(row.quantity, 1000);
    if (!quantity) throw new Biz(`Напишите, сколько заказать: ${text(good.name)}`);
    items.push({ good: text(good.id), name: text(good.name), unit: text(good.unit), quantity });
  }
  const comment = str(payload.comment, 1000);
  const id = shiftId || `pending:${pointId}:${owner}`;
  await sql`insert into supply_drafts (id, point_id, staff_id, items_json, comment, updated_at)
    values (${id}, ${pointId}, ${owner}, ${JSON.stringify(items)}, ${comment}, now())
    on conflict (id) do update set items_json = ${JSON.stringify(items)}, comment = ${comment}, updated_at = now()`;
  if (items.length) {
    const list = items.map((item) => `${item.name}: ${item.quantity}`).join("; ");
    await notify(
      sql,
      await leaderIds(sql),
      "supply",
      "Заказ хозтоваров",
      `${staff.name} отправил заказ по точке ${await pointName(sql, pointId)}: ${list}.`,
    );
  }
  return { id };
}

async function saveDelivery(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertDirector(staff);
  const pointId = must(payload.pointId, "Выберите пункт", 40);
  const goodId = must(payload.goodId, "Выберите товар", 40);
  const goods = await sql<Row>`select * from supply_goods where id = ${goodId}`;
  if (!goods[0]) throw new Biz("Неизвестный товар");
  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Biz("Укажите целое количество");
  const day = must(payload.day, "Укажите дату", 10);
  const comment = str(payload.comment, 300);
  await sql`insert into supply_deliveries (id, point_id, good_id, name, unit, quantity, day, comment, actor_id)
    values (${crypto.randomUUID()}, ${pointId}, ${goodId}, ${text(goods[0].name)}, ${text(goods[0].unit)}, ${quantity}, ${day}, ${comment}, ${staff.id})`;
  return { ok: true };
}

async function supplyStatus(sql: Sql, staff: Staff, payload: Record<string, unknown>) {
  assertLeader(staff);
  const id = must(payload.id, "Выберите отчёт", 80);
  const status = must(payload.status, "Выберите статус", 40);
  if (!["Новая", "В работе", "Выполнена"].includes(status)) throw new Biz("Неизвестный статус");
  const rows = await sql<Row>`select * from supply_reports where id = ${id}`;
  if (!rows[0]) throw new Biz("Отчёт не найден");
  assertPoint(staff, text(rows[0].point_id));
  await sql`update supply_reports set status = ${status} where id = ${id}`;
  await notify(sql, [text(rows[0].staff_id)], "supply", "Заказ хозтоваров", `${staff.name} поставил заказу статус «${status}».`);
  return { id };
}

async function excel(sql: Sql, staff: Staff) {
  assertDirector(staff);
  return buildExcel(sql);
}

async function buildExcel(sql: Sql) {
  const XLSX = await import("xlsx");
  const shifts = (await sql<Row>`select * from shifts order by day, start_time`).map(mapShift);
  const runs = await sql<Row>`select shift_id, type, finished_at, finished_by from checklist_runs`;
  const problems = await sql<Row>`select r.shift_id, r.type, count(*)::int as n
    from checklist_answers a join checklist_runs r on r.id = a.run_id
    where a.status = 'problem' group by r.shift_id, r.type`;
  const header = ["Дата", "Пункт", "Сотрудник", "Начало", "Конец", "Открытие", "Закрытие", "Статус", "Проблемы"];
  const rows: (string | number)[][] = [header];
  for (const shift of shifts) {
    const opening = runs.find((run) => text(run.shift_id) === shift.id && text(run.type) === "opening");
    const closing = runs.find((run) => text(run.shift_id) === shift.id && text(run.type) === "closing");
    const opened = Boolean(opening?.finished_at);
    const closed = Boolean(closing?.finished_at);
    const tone = openTone(shift.day, shift.start, opened);
    const status = closed ? "Сдана" : opened ? "Открыта" : tone === "red" ? "Не открыта" : "Ожидается";
    const problemCount = problems
      .filter((row) => text(row.shift_id) === shift.id)
      .reduce((sum, row) => sum + Number(row.n), 0);
    rows.push([
      ruDay(shift.day),
      await pointName(sql, shift.pointId),
      await personName(sql, shift.staffId),
      shift.start,
      shift.end,
      opening?.finished_at ? ruStamp(text(opening.finished_at)) : "—",
      closing?.finished_at ? ruStamp(text(closing.finished_at)) : "—",
      status,
      problemCount,
    ]);
  }
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [12, 36, 22, 8, 8, 18, 18, 14, 10].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(book, sheet, "Смены");
  const base64 = XLSX.write(book, { type: "base64", bookType: "xlsx" }) as string;
  return { filename: "Журнал-ПВЗ.xlsx", base64 };
}

async function saveCheckItem(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const type = payload.type === "closing" ? "closing" : "opening";
  const label = must(payload.text, "Напишите пункт", 300);
  const kind = payload.kind === "text" || payload.kind === "photo" ? payload.kind : "status";
  const id = str(payload.id, 80);
  if (id) {
    const rows = await sql`select id from checklist_items where id = ${id}`;
    if (!rows.length) throw new Biz("Пункт не найден");
    await sql`update checklist_items set text = ${label}, kind = ${kind}, type = ${type}, active = true where id = ${id}`;
    return { id };
  }
  const sortRow = await sql<{ n: number }>`select coalesce(max(sort), 0)::int as n from checklist_items where type = ${type}`;
  const created = crypto.randomUUID();
  await sql`insert into checklist_items (id, type, text, kind, sort) values (${created}, ${type}, ${label}, ${kind}, ${Number(sortRow[0]?.n ?? 0) + 1})`;
  return { id: created };
}

async function deleteCheckItem(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const id = must(payload.id, "Выберите пункт", 80);
  await sql`update checklist_items set active = false where id = ${id}`;
  return { id };
}

async function saveGood(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const name = must(payload.name, "Напишите название", 120);
  const unit = must(payload.unit, "Напишите единицу, например шт.", 40);
  const id = str(payload.id, 80);
  if (id) {
    await sql`update supply_goods set name = ${name}, unit = ${unit} where id = ${id}`;
    return { id };
  }
  const sortRow = await sql<{ n: number }>`select coalesce(max(sort), 0)::int as n from supply_goods`;
  const created = crypto.randomUUID();
  await sql`insert into supply_goods (id, name, unit, sort) values (${created}, ${name}, ${unit}, ${Number(sortRow[0]?.n ?? 0) + 1})`;
  return { id: created };
}

async function deleteGood(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const id = must(payload.id, "Выберите товар", 80);
  await sql`delete from supply_goods where id = ${id}`;
  return { id };
}

async function editReport(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  assertDirector(actor);
  const id = must(payload.id, "Выберите заказ", 80);
  const rows = await sql<Row>`select * from supply_reports where id = ${id}`;
  if (!rows[0]) throw new Biz("Заказ не найден");
  const goods = await sql<Row>`select * from supply_goods`;
  const raw = Array.isArray(payload.items) ? payload.items : [];
  const items: SupplyItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const good = goods.find((item) => text(item.id) === text(row.good));
    if (!good) throw new Biz("Неизвестный товар");
    const quantity = str(row.quantity, 1000);
    if (!quantity) continue;
    items.push({ good: text(good.id), name: text(good.name), unit: text(good.unit), quantity });
  }
  const comment = str(payload.comment, 1000);
  await sql`update supply_reports set items_json = ${JSON.stringify(items)}, comment = ${comment} where id = ${id}`;
  await notify(
    sql,
    [text(rows[0].staff_id)],
    "supply",
    "Заказ изменён",
    `${actor.name} поправил заказ хозтоваров: ${items.map((item) => `${item.name}: ${item.quantity}`).join("; ") || "позиций нет"}.`,
  );
  return { id };
}

async function dispatch(sql: Sql, staff: Staff, action: string, payload: Record<string, unknown>) {
  switch (action) {
    case "workspace":
      return workspace(sql, await loadStaff(sql, staff.id).then((fresh) => fresh ?? staff));
    case "checklist":
      return checklist(sql, staff, payload);
    case "saveAnswer":
      return saveAnswer(sql, staff, payload);
    case "saveZone":
      return saveZone(sql, staff, payload);
    case "finish":
      return finish(sql, staff, payload);
    case "correct":
      return correct(sql, staff, payload);
    case "saveShift":
      return saveShift(sql, staff, payload);
    case "publishMonth":
      return publishMonth(sql, staff, payload);
    case "removeShift":
      return removeShift(sql, staff, payload);
    case "selfShift":
      return selfShift(sql, staff, payload);
    case "saveStaff":
      return saveStaff(sql, staff, payload);
    case "deleteStaff":
      return deleteStaff(sql, staff, payload);
    case "savePoint":
      return savePoint(sql, staff, payload);
    case "deletePoint":
      return deletePoint(sql, staff, payload);
    case "savePrefs":
      return savePrefs(sql, staff, payload, false);
    case "sendPrefs":
      return savePrefs(sql, staff, payload, true);
    case "editPref":
      return editPref(sql, staff, payload);
    case "createIssue":
      return createIssue(sql, staff, payload);
    case "closeIssue":
      return closeIssue(sql, staff, payload);
    case "issuePhoto":
      return issuePhoto(sql, staff, payload);
    case "createReplacement":
      return createReplacement(sql, staff, payload);
    case "reviewReplacement":
      return reviewReplacement(sql, staff, payload);
    case "saveCheckItem":
      return saveCheckItem(sql, staff, payload);
    case "deleteCheckItem":
      return deleteCheckItem(sql, staff, payload);
    case "saveGood":
      return saveGood(sql, staff, payload);
    case "deleteGood":
      return deleteGood(sql, staff, payload);
    case "editReport":
      return editReport(sql, staff, payload);
    case "confirmShift":
      return confirmShift(sql, staff, payload);
    case "saveDraft":
      return saveDraft(sql, staff, payload);
    case "saveDelivery":
      return saveDelivery(sql, staff, payload);
    case "supplyStatus":
      return supplyStatus(sql, staff, payload);
    case "excel":
      return excel(sql, staff);
    case "markRead":
      await sql`update notifications set read = true where recipient_id = ${staff.id}`;
      return { ok: true };
    case "bindMiniApp":
      return connectMiniApp(sql, staff, payload);
    default:
      throw new Biz("Неизвестное действие");
  }
}

function publicHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Biz("Вставьте полный адрес, начиная с https://");
  }
  if (url.protocol !== "https:") throw new Biz("Нужен адрес https:// — так требует Telegram");
  if (/localhost|127\.0\.0\.1|\.local$/i.test(url.hostname)) {
    throw new Biz("Локальный адрес Telegram не примет. Сначала опубликуйте кабинет.");
  }
  return url.origin;
}

async function connectMiniApp(sql: Sql, actor: Staff, payload: Record<string, unknown>) {
  if (actor.role !== "owner") throw new Biz("Адрес мини-приложения подключает главный администратор");
  const origin = publicHttpsOrigin(must(payload.url, "Вставьте адрес кабинета", 300));
  try {
    const { bindMiniApp } = await import("./telegram.server");
    await bindMiniApp(origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ошибка Telegram";
    throw new Biz(`Telegram не принял адрес: ${message}`);
  }
  await sql`insert into app_flags (key, value) values ('mini-app-url', ${origin})
    on conflict (key) do update set value = ${origin}`;
  return { origin };
}

export async function resolveStaff(token: string | undefined): Promise<Staff | null> {
  if (!token) return null;
  const sql = await getSql();
  const rows = await sql<Row>`select staff_id from sessions where token = ${token} and expires_at > now()`;
  if (!rows[0]) return null;
  const staff = await loadStaff(sql, text(rows[0].staff_id));
  if (!staff?.active) return null;
  return staff;
}

async function issueSession(sql: Sql, staffId: string) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  await sql`insert into sessions (token, staff_id, expires_at) values (${token}, ${staffId}, ${expires})`;
  const { setCookie } = await import("@tanstack/react-start/server");
  setCookie("pvz_session", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return token;
}

export async function login(raw: string) {
  // На опубликованном сайте этого входа нет: чужой юзернейм нельзя набрать руками.
  // Форма остаётся только у вас на компьютере, когда кабинет запущен через npm run dev.
  if (process.env.NODE_ENV === "production") {
    return {
      ok: false as const,
      error: "Вход по юзернейму закрыт. Откройте кабинет кнопкой в Telegram-боте — Telegram сам подтвердит, что это вы.",
    };
  }
  let username = "";
  try {
    username = normalizeUsername(raw);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Проверьте юзернейм" };
  }
  try {
    const sql = await getSql();
    await maintain(sql);
    const rows = await sql<Row>`select id from staff where telegram_username = ${username} and active = true`;
    if (!rows[0]) {
      return { ok: false as const, error: "Этот юзернейм не приглашён. Добавить человека может руководитель или главный администратор." };
    }
    const staff = await loadStaff(sql, text(rows[0].id));
    if (!staff) return { ok: false as const, error: "Профиль не найден" };
    const token = await issueSession(sql, staff.id);
    return { ok: true as const, token, staff };
  } catch (error) {
    console.error(error);
    return { ok: false as const, error: "Не удалось войти. Повторите ещё раз." };
  }
}

/** Вход из мини-приложения: подпись Telegram проверяется на сервере, юзернейм ищется в базе. */
export async function loginTelegram(initData: string) {
  try {
    const { readWebAppUser } = await import("./telegram.server");
    const user = readWebAppUser(initData);
    const sql = await getSql();
    await maintain(sql);
    const rows = await sql<Row>`select id from staff where telegram_username = ${user.username} and active = true`;
    if (!rows[0]) {
      return {
        ok: false as const,
        error: `@${user.username} не приглашён. Добавить человека может руководитель или главный администратор.`,
      };
    }
    await sql`update staff set telegram_chat_id = ${user.chatId} where id = ${text(rows[0].id)}`;
    const staff = await loadStaff(sql, text(rows[0].id));
    if (!staff) return { ok: false as const, error: "Профиль не найден" };
    const token = await issueSession(sql, staff.id);
    return { ok: true as const, token, staff };
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Не удалось войти через Telegram";
    if (message.includes("Telegram") || message.includes("юзернейм") || message.includes("Сессия")) {
      return { ok: false as const, error: message };
    }
    return { ok: false as const, error: "Не удалось войти через Telegram. Повторите ещё раз." };
  }
}

export async function logout(staffId: string) {
  const sql = await getSql();
  await sql`delete from sessions where staff_id = ${staffId}`;
  const { deleteCookie } = await import("@tanstack/react-start/server");
  deleteCookie("pvz_session", { path: "/" });
  return { ok: true as const, data: { done: true } };
}

export async function handle(staff: Staff, action: string, payload: Record<string, unknown>) {
  try {
    const sql = await getSql();
    await maintain(sql);
    const data = await dispatch(sql, staff, action, payload);
    return { ok: true as const, data };
  } catch (error) {
    if (error instanceof Biz) return { ok: false as const, error: error.message };
    console.error(error);
    return { ok: false as const, error: error instanceof Error ? error.message : "Не удалось выполнить действие" };
  }
}
