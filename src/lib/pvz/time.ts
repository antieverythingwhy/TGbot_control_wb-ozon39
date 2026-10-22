import type { OpenTone } from "./types";

// Время сети — Калининград (UTC+2, без перехода на летнее). От него считаются
// окна открытия, опоздание в 15 минут и блокировка пожеланий с 26-го числа.

export const TZ = "Europe/Kaliningrad";
const OFFSET = "+02:00";

/** Сегодня в Калининграде, формат YYYY-MM-DD. */
export function todayISO(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  }).format(now);
}

/** Текущий месяц YYYY-MM. */
export function monthISO(now = new Date()): string {
  return todayISO(now).slice(0, 7);
}

/** Число месяца в Калининграде. Пожелания закрываются с 26-го. */
export function dayOfMonth(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit" }).format(now),
  );
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Смещение понедельника для календаря месяца. */
export function mondayOffset(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  const sunday0 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return (sunday0 + 6) % 7;
}

/** Момент начала или конца смены в миллисекундах. */
export function atShift(day: string, hm: string): number {
  return new Date(`${day}T${hm}:00${OFFSET}`).getTime();
}

/**
 * Цвет смены в графике.
 * green — открытие завершено.
 * red — с назначенного начала прошло 15 минут, а открытие не завершено.
 */
export function openTone(day: string, start: string, openingFinished: boolean, now = Date.now()): OpenTone {
  if (openingFinished) return "green";
  if (now >= atShift(day, start) + 15 * 60_000) return "red";
  if (now >= atShift(day, start) - 2 * 60 * 60_000) return "wait";
  return "idle";
}

export function ruDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}

export function ruStamp(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function monthTitle(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}
