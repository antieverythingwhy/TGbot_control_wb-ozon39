// Секрет будильника. Его знает только сервер и сайт, который раз в минуту открывает /api/cron.
// Так напоминания уходят, даже если в кабинет никто не заходил.
import { timingSafeEqual } from "node:crypto";

const FALLBACK = "pvz_cron_7f3a9c2e1b84d056a8e4c91f02d6b7a3";

export function cronSecret(): string {
  const fromEnv = process.env.CRON_SECRET?.trim();
  return fromEnv || FALLBACK;
}

export function cronAuthorized(request: Request): boolean {
  const header = request.headers.get("x-cron-secret") ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.slice(0, 7).toLowerCase() === "bearer " ? auth.slice(7).trim() : "";
  return same(header, cronSecret()) || same(bearer, cronSecret());
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
