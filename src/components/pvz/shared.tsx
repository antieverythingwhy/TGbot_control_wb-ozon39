// Общие куски интерфейса кабинета: кнопки, модалка и подписи смен.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { OpenTone, Role, Shift, Workspace } from "@/lib/pvz/types";
import { openTone, ruDay, ruStamp } from "@/lib/pvz/time";

export type Page =
  | "home"
  | "opening"
  | "closing"
  | "schedule"
  | "issue"
  | "contact"
  | "supplies"
  | "inbox"
  | "control"
  | "staff"
  | "points";

export type Act = <T>(action: string, payload?: Record<string, unknown>) => Promise<T | null>;

export type Gate = {
  ws: Workspace;
  pointId: string;
  setPage: (page: Page) => void;
  shiftId: string | null;
  setShiftId: (id: string | null) => void;
  act: Act;
  busy: boolean;
};

export const fieldClass = "h-11 w-full rounded-control border border-line bg-card px-3 text-sm text-ink";
export const areaClass = "min-h-24 w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink";

export function Btn({
  kind = "primary",
  className = "",
  type,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "soft" | "danger" }) {
  const look = {
    primary: "bg-accent text-accent-fg",
    ghost: "border border-line bg-card text-ink",
    soft: "bg-accent-soft text-accent",
    danger: "bg-bad-soft text-bad",
  }[kind];
  return (
    <button
      type={type ?? (onClick ? "button" : "submit")}
      onClick={onClick}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-control px-4 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${look} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 flex flex-col gap-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 p-3 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-panel bg-card p-5 shadow-sm"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="grid h-11 w-11 place-items-center rounded-control border border-line" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "bad" | "wait" | "idle"; children: ReactNode }) {
  const look = {
    ok: "bg-ok-soft text-ok",
    bad: "bg-bad-soft text-bad",
    wait: "bg-warn-soft text-warn",
    idle: "bg-accent-soft text-accent",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${look}`}>{children}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-panel border border-line bg-card p-4 shadow-sm ${className}`}>{children}</section>;
}

export function personName(ws: Workspace, id: string): string {
  return ws.people.find((person) => person.id === id)?.name ?? "Сотрудник";
}

export function pointName(ws: Workspace, id: string): string {
  return ws.points.find((point) => point.id === id)?.name ?? "Пункт";
}

export function openingDone(ws: Workspace, shiftId: string): boolean {
  return ws.runs.some((run) => run.shiftId === shiftId && run.type === "opening" && run.finishedAt);
}

export function closingDone(ws: Workspace, shiftId: string): boolean {
  return ws.runs.some((run) => run.shiftId === shiftId && run.type === "closing" && run.finishedAt);
}

export function toneOf(ws: Workspace, shift: Shift): OpenTone {
  return openTone(shift.day, shift.start, openingDone(ws, shift.id));
}

export function toneWord(tone: OpenTone): string {
  if (tone === "green") return "Смена открыта";
  if (tone === "red") return "Не открыта";
  if (tone === "wait") return "Пора открывать";
  return "Ожидается";
}

export function toneBadge(tone: OpenTone): "ok" | "bad" | "wait" | "idle" {
  if (tone === "green") return "ok";
  if (tone === "red") return "bad";
  if (tone === "wait") return "wait";
  return "idle";
}

export function shiftTitle(ws: Workspace, shift: Shift): string {
  return `${ruDay(shift.day)} · ${shift.start}–${shift.end} · ${pointName(ws, shift.pointId)}`;
}

/** Смена, с которой сейчас работает экран открытия или закрытия. */
export function activeShift(ws: Workspace, pointId: string, selected: string | null): Shift | null {
  const list = ws.shifts
    .filter((shift) => shift.pointId === pointId && (ws.me.role !== "employee" || shift.staffId === ws.me.id))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
  if (selected && list.some((shift) => shift.id === selected)) return list.find((shift) => shift.id === selected) ?? null;
  return list.find((shift) => shift.day === ws.today) ?? list.find((shift) => shift.day >= ws.today) ?? list.at(-1) ?? null;
}

export function when(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return ruStamp(time);
}

export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Выберите изображение");
  if (file.size > 15 * 1024 * 1024) throw new Error("Максимум 15 МБ");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const pic = new Image();
      pic.onload = () => resolve(pic);
      pic.onerror = () => reject(new Error("Не удалось прочитать фото"));
      pic.src = url;
    });
    const scale = Math.min(1, 900 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Не удалось обработать фото");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.62);
    if (data.length > 500_000) throw new Error("Фото слишком большое даже после сжатия");
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function saveFile(filename: string, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function roleCan(role: Role, page: Page): boolean {
  if (page === "control" || page === "staff" || page === "points") return role !== "employee";
  return true;
}
