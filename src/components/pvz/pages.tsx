// Экраны кабинета. Стартовый экран — «Главная», вкладки про запуск нет.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { call } from "@/lib/pvz/api";
import { ISSUE_CATEGORIES, PREF_OPTIONS, PRIORITIES, ZONES, statusLabel } from "@/lib/pvz/catalog";
import { daysInMonth, mondayOffset, monthTitle, nextMonth, ruDay } from "@/lib/pvz/time";
import type { Checklist, Shift, Staff } from "@/lib/pvz/types";
import { isChief, isLeader, roleLabel } from "@/lib/pvz/types";
import { configuredOwnerUsername } from "@/lib/pvz/owner";
import {
  Badge,
  Btn,
  Card,
  Field,
  Modal,
  activeShift,
  areaClass,
  closingDone,
  compressImage,
  fieldClass,
  openingDone,
  personName,
  pointName,
  saveFile,
  shiftTitle,
  toneBadge,
  toneOf,
  toneWord,
  when,
  type Gate,
} from "./shared";

function peopleOnPoint(gate: Gate, pointId: string): Staff[] {
  return gate.ws.people.filter(
    (person) => person.active && person.role === "employee" && person.pointIds.includes(pointId),
  );
}

export function HomePage(gate: Gate) {
  const { ws, pointId, setPage, act, busy } = gate;
  const shift = activeShift(ws, pointId, null);
  const tone = shift ? toneOf(ws, shift) : "idle";
  const todayShifts = ws.shifts.filter((item) => item.day === ws.today && item.pointId === pointId);
  const issues = ws.issues.filter((issue) => issue.pointId === pointId && issue.status !== "Закрыта");
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Добрый день, {ws.me.name}</h1>
        <p className="text-sm text-muted">
          {roleLabel(ws.me.role)} · {pointName(ws, pointId)} · {ws.nowLabel}
        </p>
      </header>
      {ws.me.role === "employee" ? (
        <Card>
          <p className="text-sm text-muted">{shift && shift.day === ws.today ? "Сегодняшняя смена" : "Ближайшая смена"}</p>
          <p className="mt-1 text-xl font-semibold">{shift ? shiftTitle(ws, shift) : "Назначенных смен нет"}</p>
          {shift ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone={toneBadge(tone)}>{toneWord(tone)}</Badge>
              {closingDone(ws, shift.id) ? <Badge tone="ok">Сдана</Badge> : null}
              <Btn kind="soft" disabled={busy || shift.confirmed} onClick={() => void act("confirmShift", { shiftId: shift.id })}>
                {shift.confirmed ? "Выход подтверждён" : "Подтвердить выход"}
              </Btn>
            </div>
          ) : null}
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Btn onClick={() => setPage("opening")}>Открыть смену</Btn>
            <Btn kind="ghost" onClick={() => setPage("closing")}>Закрыть смену</Btn>
            <Btn kind="ghost" onClick={() => setPage("schedule")}>График и пожелания</Btn>
            <Btn kind="ghost" onClick={() => setPage("issue")}>Сообщить о проблеме</Btn>
          </div>
          {tone === "red" ? (
            <p className="mt-3 text-sm text-bad">
              С назначенного времени прошло больше 15 минут. В графике день красный, пока смена не будет открыта.
            </p>
          ) : null}
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <p className="text-sm text-muted">Смены сегодня</p>
            <p className="text-2xl font-semibold tabular-nums">{todayShifts.length}</p>
          </Card>
          <Card>
            <p className="text-sm text-muted">Открыты</p>
            <p className="text-2xl font-semibold tabular-nums">{todayShifts.filter((item) => openingDone(ws, item.id)).length}</p>
          </Card>
          <Card>
            <p className="text-sm text-muted">Не открыты</p>
            <p className="text-2xl font-semibold tabular-nums">{todayShifts.filter((item) => toneOf(ws, item) === "red").length}</p>
          </Card>
          <Card>
            <p className="text-sm text-muted">Проблемы</p>
            <p className="text-2xl font-semibold tabular-nums">{issues.length}</p>
          </Card>
        </div>
      )}
      {isChief(ws.me.role) ? (
        <Card>
          <h2 className="font-semibold">Актуальный журнал Excel</h2>
          <p className="mt-1 text-sm text-muted">
            Один и тот же файл «Журнал-ПВЗ». Каждый раз он собирается заново из базы: все смены, открытия, закрытия и дни, которые так и не открыли.
          </p>
          <Btn
            className="mt-3"
            disabled={busy}
            onClick={async () => {
              const file = await act<{ filename: string; base64: string }>("excel");
              if (file) saveFile(file.filename, file.base64);
            }}
          >
            Скачать актуальный журнал
          </Btn>
        </Card>
      ) : null}
      <Card>
        <h2 className="mb-3 font-semibold">Последние сообщения бота</h2>
        {ws.notices.slice(0, 4).map((notice) => (
          <p key={notice.id} className="border-t border-line py-2 text-sm">
            <b>{notice.title}.</b> {notice.body}
          </p>
        ))}
        {ws.notices.length === 0 ? <p className="text-sm text-muted">Пока тихо.</p> : null}
        <Btn kind="ghost" className="mt-3" onClick={() => setPage("inbox")}>
          Все уведомления
        </Btn>
      </Card>
    </div>
  );
}

export function CheckPage({ gate, type }: { gate: Gate; type: "opening" | "closing" }) {
  const shift = activeShift(gate.ws, gate.pointId, gate.shiftId);
  const choices = gate.ws.shifts
    .filter((item) => item.pointId === gate.pointId)
    .sort((a, b) => b.day.localeCompare(a.day));
  const query = useQuery({
    queryKey: ["checklist", shift?.id, type],
    enabled: Boolean(shift),
    queryFn: () => call<Checklist>("checklist", { shiftId: shift?.id, type }),
  });
  const qc = useQueryClient();
  async function save(payload: Record<string, unknown>) {
    const next = await gate.act<Checklist>(type === "closing" && payload.zone ? "saveZone" : "saveAnswer", {
      shiftId: shift?.id,
      type,
      ...payload,
    });
    if (next) qc.setQueryData(["checklist", shift?.id, type], next);
    return next;
  }
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{type === "opening" ? "Открытие смены" : "Закрытие смены"}</h1>
        <p className="text-sm text-muted">{shift ? shiftTitle(gate.ws, shift) : "Нет смены на этом пункте"}</p>
      </header>
      {isLeader(gate.ws.me.role) ? (
        <Card>
          <Field label="Смена этого пункта">
            <select
              className={fieldClass}
              value={shift?.id ?? ""}
              onChange={(event) => gate.setShiftId(event.target.value)}
            >
              {choices.map((item) => (
                <option key={item.id} value={item.id}>
                  {ruDay(item.day)} {item.start}–{item.end} · {personName(gate.ws, item.staffId)}
                </option>
              ))}
            </select>
          </Field>
          <Btn
            kind="soft"
            disabled={gate.busy}
            onClick={async () => {
              const created = await gate.act<{ id: string }>("selfShift", { pointId: gate.pointId });
              if (created) gate.setShiftId(created.id);
            }}
          >
            Открыть смену самому
          </Btn>
        </Card>
      ) : null}
      {!shift ? <Card>Назначьте смену в контроле пункта.</Card> : null}
      {query.isLoading ? <Card>Собираем чек-лист…</Card> : null}
      {query.data ? <CheckForm gate={gate} data={query.data} save={save} /> : null}
      {query.error ? <Card>{query.error instanceof Error ? query.error.message : "Не удалось открыть чек-лист"}</Card> : null}
    </div>
  );
}

function CheckForm({
  gate,
  data,
  save,
}: {
  gate: Gate;
  data: Checklist;
  save: (payload: Record<string, unknown>) => Promise<Checklist | null>;
}) {
  const [reason, setReason] = useState("");
  const [itemId, setItemId] = useState(data.answers[0]?.itemId ?? "");
  const [status, setStatus] = useState("ok");
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={toneBadge(data.tone)}>{toneWord(data.tone)}</Badge>
        <span className="text-sm text-muted">
          Начало: {data.startedAt ? when(data.startedAt) : "не начато"}
          {data.finishedAt ? ` · сдано: ${when(data.finishedAt)} (${data.finishedByName})` : ""}
        </span>
      </div>
      {data.lockReason ? <p className="mb-3 text-sm text-warn">{data.lockReason}</p> : null}
      <div className="grid gap-3">
        {data.answers.map((answer) => (
          <div key={answer.itemId} className="rounded-control border border-line p-3">
            <p className="font-medium">{answer.text}</p>
            <select
              className={`${fieldClass} mt-2`}
              disabled={data.locked || gate.busy}
              value={answer.status}
              onChange={(event) => void save({ itemId: answer.itemId, status: event.target.value, comment: answer.comment, priority: answer.priority })}
            >
              <option value="">Выберите результат</option>
              <option value="ok">В порядке</option>
              <option value="problem">Есть проблема</option>
              <option value="na">Не относится к этому ПВЗ</option>
            </select>
            {answer.status === "problem" || answer.kind === "text" ? (
              <textarea
                className={`${areaClass} mt-2`}
                disabled={data.locked || gate.busy}
                defaultValue={answer.comment}
                placeholder={answer.status === "problem" ? "Что случилось" : "Комментарий. Если вопросов нет — напишите «нет»"}
                onBlur={(event) =>
                  void save({
                    itemId: answer.itemId,
                    status: answer.status,
                    comment: event.target.value,
                    priority: answer.priority,
                  })
                }
              />
            ) : null}
            {answer.status === "problem" ? (
              <div className="mt-2 grid gap-2">
                <select
                  className={fieldClass}
                  disabled={data.locked || gate.busy}
                  value={answer.priority || "Обычная"}
                  onChange={(event) =>
                    void save({ itemId: answer.itemId, status: answer.status, comment: answer.comment, priority: event.target.value })
                  }
                >
                  {PRIORITIES.map((priority) => (
                    <option key={priority}>{priority}</option>
                  ))}
                </select>
                <label className="text-sm">
                  Фото проблемы
                  <input
                    className="mt-1 block w-full text-sm"
                    type="file"
                    accept="image/*"
                    disabled={data.locked || gate.busy}
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      try {
                        const photo = await compressImage(file);
                        await save({ itemId: answer.itemId, status: answer.status, comment: answer.comment, priority: answer.priority || "Обычная", photo });
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Фото не принято");
                      }
                    }}
                  />
                </label>
                {answer.photo ? <img src={answer.photo} alt="Фото проблемы" className="h-24 w-32 rounded-control object-cover" /> : null}
              </div>
            ) : null}
            {answer.kind === "photo" ? (
              <label className="mt-2 block text-sm">
                Фото пункта
                <input
                  className="mt-1 block w-full text-sm"
                  type="file"
                  accept="image/*"
                  disabled={data.locked || gate.busy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const photo = await compressImage(file);
                      await save({ itemId: answer.itemId, status: answer.status || "ok", comment: answer.comment, photo });
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Фото не принято");
                    }
                  }}
                />
                {answer.photo ? <img src={answer.photo} alt="Фото пункта" className="mt-2 h-24 w-32 rounded-control object-cover" /> : null}
              </label>
            ) : null}
          </div>
        ))}
      </div>
      {data.type === "closing" ? (
        <div className="mt-4 grid gap-3">
          <h2 className="font-semibold">Фото по зонам</h2>
          {ZONES.map((zone) => {
            const photo = data.zones.find((item) => item.zone === zone)?.photo ?? "";
            return (
              <label key={zone} className="text-sm">
                {zone}
                <input
                  className="mt-1 block w-full text-sm"
                  type="file"
                  accept="image/*"
                  disabled={data.locked || gate.busy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const image = await compressImage(file);
                      await save({ zone, photo: image });
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Фото не принято");
                    }
                  }}
                />
                {photo ? <img src={photo} alt={zone} className="mt-2 h-24 w-32 rounded-control object-cover" /> : null}
              </label>
            );
          })}
        </div>
      ) : null}
      <Btn
        className="mt-4"
        disabled={data.locked || gate.busy || !data.canFinish}
        onClick={() => {
          if (!confirm(data.type === "opening" ? "Завершить открытие и отправить отчёт руководителю?" : "Сдать смену и отправить отчёт?")) return;
          void gate.act("finish", { shiftId: data.shift.id, type: data.type });
        }}
      >
        {data.finishedAt ? "Отчёт уже сдан" : data.type === "opening" ? "Подтвердить открытие" : "Подтвердить сдачу"}
      </Btn>
      {isLeader(gate.ws.me.role) && data.finishedAt ? (
        <form
          className="mt-4 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void gate.act("correct", { shiftId: data.shift.id, type: data.type, itemId, status, reason });
          }}
        >
          <h2 className="mb-2 font-semibold">Исправление руководителя</h2>
          <Field label="Пункт">
            <select className={fieldClass} value={itemId} onChange={(event) => setItemId(event.target.value)}>
              {data.answers.map((answer) => (
                <option key={answer.itemId} value={answer.itemId}>
                  {answer.text}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Новый результат">
            <select className={fieldClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="ok">В порядке</option>
              <option value="problem">Есть проблема</option>
              <option value="na">Не относится</option>
            </select>
          </Field>
          <Field label="Причина">
            <textarea className={areaClass} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Btn kind="ghost" disabled={gate.busy}>
            Записать исправление
          </Btn>
        </form>
      ) : null}
      {data.history.length ? (
        <div className="mt-4 text-sm text-muted">
          {data.history.map((line, index) => (
            <p key={`${line.at}-${index}`}>
              {line.actor}: {line.text}
            </p>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-muted">Текущие отметки: {data.answers.filter((answer) => answer.status).map((answer) => `${answer.text} — ${statusLabel(answer.status)}`).join("; ") || "пока пусто"}</p>
    </Card>
  );
}

export function SchedulePage(gate: Gate) {
  const { ws, pointId, act, busy } = gate;
  const [month, setMonth] = useState(ws.month);
  const [scope, setScope] = useState(ws.me.role === "employee" ? "mine" : "all");
  const [shiftId, setShiftId] = useState("");
  const [colleagueId, setColleagueId] = useState("");
  const [counterShiftId, setCounterShiftId] = useState("");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const target = nextMonth(ws.month);
  const mine = ws.prefs.find((batch) => batch.staffId === ws.me.id && batch.month === target);
  const [days, setDays] = useState(() => {
    const map = new Map((mine?.days ?? []).map((day) => [day.day, day]));
    return Array.from({ length: daysInMonth(target) }, (_, index) => {
      const saved = map.get(index + 1);
      return { day: index + 1, status: saved?.status ?? "", comment: saved?.comment ?? "" };
    });
  });
  const shown = ws.shifts.filter((shift) => {
    if (!shift.day.startsWith(month) || shift.pointId !== pointId) return false;
    if (scope === "mine") return shift.staffId === ws.me.id;
    return true;
  });
  const offset = mondayOffset(month);
  const cells = Array.from({ length: daysInMonth(month) }, (_, index) => month + "-" + String(index + 1).padStart(2, "0"));
  const ownFuture = ws.shifts.filter((shift) => shift.staffId === ws.me.id && shift.pointId === pointId && shift.day >= ws.today);
  const colleagues = ws.people.filter(
    (person) => person.active && person.role === "employee" && person.id !== ws.me.id && person.pointIds.includes(pointId),
  );
  const counterShifts = ws.shifts.filter((shift) => shift.staffId === colleagueId && shift.day >= ws.today && shift.id !== shiftId);
  const incoming = ws.replacements.filter((request) => request.replacementId === ws.me.id && request.status === "На рассмотрении");
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">График</h1>
        <p className="text-sm text-muted">Зелёный — смена открыта. Красный — прошло 15 минут, а открытия нет.</p>
      </header>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className={fieldClass} style={{ maxWidth: 180 }} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          <select className={fieldClass} style={{ maxWidth: 220 }} value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="mine">Мои смены</option>
            <option value="all">График пункта</option>
          </select>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-xs">
          {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
            <div key={day} className="px-1 text-muted">
              {day}
            </div>
          ))}
          {Array.from({ length: offset }, (_, index) => (
            <div key={`pad-${index}`} />
          ))}
          {cells.map((day) => (
            <div key={day} className="min-h-16 rounded-control border border-line p-1">
              <b>{Number(day.slice(-2))}</b>
              {shown
                .filter((shift) => shift.day === day)
                .map((shift) => {
                  const tone = toneOf(ws, shift);
                  const look = tone === "green" ? "bg-ok-soft text-ok" : tone === "red" ? "bg-bad-soft text-bad" : "bg-bg text-ink";
                  return (
                    <p key={shift.id} className={`mt-1 rounded-control px-1 py-0.5 ${look}`}>
                      {personName(ws, shift.staffId).split(" ")[0]} {shift.start}
                    </p>
                  );
                })}
            </div>
          ))}
        </div>
      </Card>
      {ws.me.role === "employee" ? (
        <Card>
          <h2 className="font-semibold">Пожелания на {monthTitle(target)}</h2>
          <p className="mb-3 text-sm text-muted">
            {ws.wishesLocked ? "С 26-го числа форма закрыта. Дальше правит руководитель." : "Можно менять до 25-го числа включительно. Это не назначенные смены."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {days.map((day) => (
              <div key={day.day} className="rounded-control border border-line p-2">
                <p className="text-sm font-semibold">{day.day}</p>
                <select
                  className={`${fieldClass} mt-1`}
                  disabled={ws.wishesLocked || busy}
                  value={day.status}
                  onChange={(event) => setDays((list) => list.map((item) => (item.day === day.day ? { ...item, status: event.target.value } : item)))}
                >
                  {PREF_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className={`${fieldClass} mt-1`}
                  disabled={ws.wishesLocked || busy}
                  placeholder="Комментарий"
                  value={day.comment}
                  onChange={(event) => setDays((list) => list.map((item) => (item.day === day.day ? { ...item, comment: event.target.value } : item)))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn kind="ghost" disabled={busy || ws.wishesLocked} onClick={() => void act("savePrefs", { days })}>
              Сохранить черновик
            </Btn>
            <Btn disabled={busy || ws.wishesLocked} onClick={() => void act("sendPrefs", { days })}>
              Отправить руководителю
            </Btn>
          </div>
        </Card>
      ) : null}
      <Card>
        <h2 className="mb-2 font-semibold">Попросить замену</h2>
        <p className="mb-3 text-sm text-muted">Коллега соглашается сам. После согласия график меняется, сообщение уходит вам обоим и руководителю.</p>
        {incoming.length ? (
          <div className="mb-4 grid gap-2">
            {incoming.map((request) => (
              <div key={request.id} className="rounded-control border border-line p-3 text-sm">
                <p>
                  <b>{personName(ws, request.requesterId)}</b> предлагает смену {ruDay(request.day)}. {request.reason}
                </p>
                {(() => {
                  const counter = ws.shifts.find((shift) => shift.id === request.counterShiftId);
                  if (!request.counterShiftId) return <p className="text-muted">Нужно выйти вместо коллеги, свою смену отдавать не просят.</p>;
                  if (!counter) return <p className="text-muted">Взамен просит вашу смену.</p>;
                  return <p className="text-muted">Взамен просит смену {shiftTitle(ws, counter)}.</p>;
                })()}
                <div className="mt-2 flex gap-2">
                  <Btn disabled={busy} onClick={() => void act("reviewReplacement", { id: request.id, approve: true })}>
                    Согласиться
                  </Btn>
                  <Btn kind="danger" disabled={busy} onClick={() => void act("reviewReplacement", { id: request.id, approve: false })}>
                    Отказаться
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act("createReplacement", { shiftId, colleagueId, counterShiftId, reason, comment });
          }}
        >
          <Field label="Моя смена">
            <select className={fieldClass} value={shiftId} onChange={(event) => setShiftId(event.target.value)}>
              <option value="">Выберите</option>
              {ownFuture.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shiftTitle(ws, shift)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Коллега">
            <select className={fieldClass} value={colleagueId} onChange={(event) => setColleagueId(event.target.value)}>
              <option value="">Выберите</option>
              {colleagues.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Его смена взамен, если меняетесь">
            <select className={fieldClass} value={counterShiftId} onChange={(event) => setCounterShiftId(event.target.value)}>
              <option value="">Не меняться, только чтобы вышел вместо меня</option>
              {counterShifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shiftTitle(ws, shift)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Причина">
            <input className={fieldClass} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Field label="Комментарий">
            <textarea className={areaClass} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <Btn disabled={busy || !shiftId || !colleagueId}>Отправить коллеге</Btn>
        </form>
        <div className="mt-4 grid gap-2">
          {ws.replacements
            .filter((request) => request.pointId === pointId)
            .map((request) => (
              <p key={request.id} className="text-sm">
                <b>{ruDay(request.day)}</b> · {personName(ws, request.requesterId)} · {request.reason} · {request.status}
              </p>
            ))}
        </div>
      </Card>
    </div>
  );
}

export function IssuePage(gate: Gate) {
  const { ws, pointId, act, busy } = gate;
  const [category, setCategory] = useState(ISSUE_CATEGORIES[0]);
  const [priority, setPriority] = useState(PRIORITIES[0]);
  const [body, setBody] = useState("");
  const [photo, setPhoto] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const list = ws.issues.filter((issue) => issue.pointId === pointId);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h1 className="mb-3 text-2xl font-semibold tracking-tight">Сообщить о проблеме</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act("createIssue", { pointId, category, priority, body, photo }).then((id) => {
              if (id) {
                setBody("");
                setPhoto("");
                toast.success("Проблема отправлена");
              }
            });
          }}
        >
          <Field label="Категория">
            <select className={fieldClass} value={category} onChange={(event) => setCategory(event.target.value)}>
              {ISSUE_CATEGORIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label="Приоритет">
            <select className={fieldClass} value={priority} onChange={(event) => setPriority(event.target.value)}>
              {PRIORITIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label="Описание">
            <textarea className={areaClass} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <Field label="Фотография">
            <input
              className="text-sm"
              type="file"
              accept="image/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  setPhoto(await compressImage(file));
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Фото не принято");
                }
              }}
            />
          </Field>
          {photo ? <img src={photo} alt="Вложение" className="mb-3 h-24 w-32 rounded-control object-cover" /> : null}
          <Btn disabled={busy}>Отправить</Btn>
        </form>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Сообщения по пункту</h2>
        {list.length === 0 ? <p className="text-sm text-muted">Пока нет.</p> : null}
        {list.map((issue) => (
          <article key={issue.id} className="border-t border-line py-3 text-sm">
            <p className="font-semibold">{issue.category}</p>
            <p>{issue.body}</p>
            <p className="text-muted">
              {personName(ws, issue.staffId)} · {issue.priority} · {issue.status}
              {issue.resolution ? ` · ${issue.resolution}` : ""}
            </p>
            {issue.hasPhoto ? (
              shown[issue.id] ? (
                <img src={shown[issue.id]} alt="Фото проблемы" className="mt-2 h-24 w-32 rounded-control object-cover" />
              ) : (
                <button
                  type="button"
                  className="mt-1 text-accent"
                  onClick={async () => {
                    const file = await act<{ photo: string }>("issuePhoto", { id: issue.id });
                    if (file?.photo) setShown((map) => ({ ...map, [issue.id]: file.photo }));
                  }}
                >
                  Показать фото
                </button>
              )
            ) : null}
          </article>
        ))}
      </Card>
    </div>
  );
}

export function ContactPage(gate: Gate) {
  const leaders = gate.ws.people.filter((person) => person.active && person.role !== "employee");
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Связаться</h1>
        <p className="text-sm text-muted">{pointName(gate.ws, gate.pointId)}</p>
      </header>
      {leaders.map((person) => (
        <Card key={person.id}>
          <p className="font-semibold">{person.name}</p>
          <p className="text-sm text-muted">
            {roleLabel(person.role)} · @{person.username}
          </p>
          {person.phone ? (
            <a className="mt-2 inline-flex h-11 items-center font-semibold text-accent" href={`tel:${person.phone}`}>
              {person.phone}
            </a>
          ) : (
            <p className="mt-2 text-sm text-muted">Телефон не указан</p>
          )}
        </Card>
      ))}
      <Card>
        <p className="text-sm text-muted">
          Открытие, закрытие, проблемы, заказы и замены уходят администраторам и руководителю — в кабинет и в Telegram, если человек нажал /start у бота.
        </p>
      </Card>
    </div>
  );
}

export function InboxPage(gate: Gate) {
  const { ws } = gate;
  const notices = ws.notices;
  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Уведомления</h1>
      <p className="text-sm text-muted">
        Те же сообщения уходят в Telegram-бота{ws.botUsername ? ` @${ws.botUsername}` : ""}, если вы открыли его и нажали /start.
        {ws.me.botLinked ? " Ваш чат уже привязан." : " Ваш чат ещё не привязан."}
      </p>
      {notices.length === 0 ? <Card>Сообщений пока нет.</Card> : null}
      {notices.map((notice) => (
        <Card key={notice.id}>
          <p className="text-xs text-muted">{when(notice.createdAt)}</p>
          <p className="font-semibold">{notice.title}</p>
          <p className="whitespace-pre-wrap text-sm">{notice.body}</p>
        </Card>
      ))}
    </div>
  );
}

export function SuppliesPage(gate: Gate) {
  const { ws, pointId, act, busy } = gate;
  const shift = activeShift(ws, pointId, gate.shiftId);
  const closed = shift ? closingDone(ws, shift.id) : false;
  const draft =
    ws.drafts.find((item) => item.id === shift?.id) ??
    ws.drafts.find((item) => item.id === `pending:${pointId}:${shift?.staffId ?? ws.me.id}`);
  const initial = useMemo(() => new Map((draft?.items ?? []).map((item) => [item.good, item.quantity])), [draft?.id, draft?.updatedAt]);
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(initial));
  const [comment, setComment] = useState(draft?.comment ?? "");
  const reports = ws.reports.filter((report) => report.pointId === pointId);
  const deliveries = ws.deliveries.filter((row) => row.pointId === pointId);
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Хозтовары</h1>
        <p className="text-sm text-muted">{pointName(ws, pointId)}</p>
      </header>
      <Card>
        <h2 className="font-semibold">Что заказать</h2>
        <p className="mb-3 text-sm text-muted">
          {shift ? shiftTitle(ws, shift) : "Открытой смены нет: заказ сохранится и войдёт в следующую сдачу."}
          {closed ? " Эта смена уже сдана." : ""}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const items = Object.entries(picked)
              .filter(([, quantity]) => quantity.trim())
              .map(([good, quantity]) => ({ good, quantity }));
            void act("saveDraft", { pointId, shiftId: shift && !closed ? shift.id : "", items, comment });
          }}
        >
          {ws.goods.map((good) => {
            const on = picked[good.id] != null;
            return (
              <div key={good.id} className="border-t border-line py-3">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="h-6 w-6"
                    checked={on}
                    disabled={closed || busy}
                    onChange={(event) =>
                      setPicked((map) => {
                        const next = { ...map };
                        if (event.target.checked) next[good.id] = next[good.id] ?? "";
                        else delete next[good.id];
                        return next;
                      })
                    }
                  />
                  {good.name}
                  <span className="text-muted">{good.unit}</span>
                </label>
                {on ? (
                  <textarea
                    className={`${areaClass} mt-2`}
                    disabled={closed || busy}
                    required
                    placeholder="Сколько заказать, например 2 штуки"
                    value={picked[good.id] ?? ""}
                    onChange={(event) => setPicked((map) => ({ ...map, [good.id]: event.target.value }))}
                  />
                ) : null}
              </div>
            );
          })}
          <Field label="Комментарий">
            <textarea className={areaClass} disabled={closed || busy} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <Btn disabled={busy || closed}>Сохранить заказ</Btn>
        </form>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Привезено</h2>
        {ws.goods.map((good) => {
          const total = deliveries.filter((row) => row.goodId === good.id).reduce((sum, row) => sum + row.quantity, 0);
          return (
            <p key={good.id} className="text-sm">
              {good.name}: {total} {good.unit}
            </p>
          );
        })}
        {isChief(ws.me.role) ? <DeliveryForm gate={gate} /> : <p className="mt-2 text-sm text-muted">Поставку записывает руководитель.</p>}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Отчёты по сданным сменам</h2>
        {reports.length === 0 ? <p className="text-sm text-muted">Появятся после закрытия смены.</p> : null}
        {reports.map((report) => (
          <article key={report.id} className="border-t border-line py-3 text-sm">
            <p className="font-semibold">
              {ruDay(report.createdAt.slice(0, 10))} · {personName(ws, report.staffId)} · {report.status}
            </p>
            <p>{report.items.map((item) => `${item.name}: ${item.quantity}`).join("; ") || "Потребность не указана"}</p>
            {report.comment ? <p>{report.comment}</p> : null}
            {isLeader(ws.me.role) ? (
              <select
                className={`${fieldClass} mt-2`}
                value={report.status}
                onChange={(event) => void act("supplyStatus", { id: report.id, status: event.target.value })}
              >
                {["Новая", "В работе", "Выполнена"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            ) : null}
            {isChief(ws.me.role) ? <ReportEdit gate={gate} report={report} /> : null}
          </article>
        ))}
      </Card>
    </div>
  );
}

function ReportEdit({ gate, report }: { gate: Gate; report: { id: string; comment: string; items: { good: string; quantity: string }[] } }) {
  const initial = Object.fromEntries(report.items.map((item) => [item.good, item.quantity]));
  const [picked, setPicked] = useState<Record<string, string>>(initial);
  const [comment, setComment] = useState(report.comment);
  return (
    <form
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        const items = Object.entries(picked)
          .filter(([, quantity]) => quantity.trim())
          .map(([good, quantity]) => ({ good, quantity }));
        void gate.act("editReport", { id: report.id, items, comment });
      }}
    >
      {gate.ws.goods.map((good) => (
        <label key={good.id} className="mt-1 flex items-center gap-2 text-sm">
          <span className="w-40 shrink-0">{good.name}</span>
          <input
            className={fieldClass}
            placeholder={good.unit}
            value={picked[good.id] ?? ""}
            onChange={(event) => setPicked((map) => ({ ...map, [good.id]: event.target.value }))}
          />
        </label>
      ))}
      <input className={`${fieldClass} mt-2`} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Комментарий" />
      <Btn className="mt-2" kind="ghost" disabled={gate.busy}>
        Сохранить заказ
      </Btn>
    </form>
  );
}

function DeliveryForm({ gate }: { gate: Gate }) {
  const [goodId, setGoodId] = useState(gate.ws.goods[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [day, setDay] = useState(gate.ws.today);
  const [comment, setComment] = useState("");
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void gate.act("saveDelivery", { pointId: gate.pointId, goodId, quantity: Number(quantity), day, comment });
      }}
    >
      <Field label="Товар">
        <select className={fieldClass} value={goodId} onChange={(event) => setGoodId(event.target.value)}>
          {gate.ws.goods.map((good) => (
            <option key={good.id} value={good.id}>
              {good.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Сколько привезли">
        <input className={fieldClass} type="number" min={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
      </Field>
      <Field label="Дата">
        <input className={fieldClass} type="date" value={day} onChange={(event) => setDay(event.target.value)} />
      </Field>
      <Field label="Комментарий">
        <input className={fieldClass} value={comment} onChange={(event) => setComment(event.target.value)} />
      </Field>
      <Btn disabled={gate.busy}>Записать поставку</Btn>
    </form>
  );
}

function CatalogCard({ gate }: { gate: Gate }) {
  const { ws, act, busy } = gate;
  const [opening, setOpening] = useState("");
  const [openingKind, setOpeningKind] = useState("status");
  const [closing, setClosing] = useState("");
  const [closingKind, setClosingKind] = useState("status");
  const [good, setGood] = useState("");
  const [unit, setUnit] = useState("шт.");
  const openingItems = ws.checks.filter((item) => item.type === "opening");
  const closingItems = ws.checks.filter((item) => item.type === "closing");
  return (
    <Card>
      <h2 className="font-semibold">Что можно менять</h2>
      <p className="mb-3 text-sm text-muted">
        Новую точку — на вкладке «Пункты». Здесь правятся пункты открытия и закрытия и список хозтоваров. Уже сданные отчёты остаются как были. Заказ по смене правится ниже, в «Хозтоварах».
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <CheckListEditor title="Открытие" type="opening" items={openingItems} value={opening} setValue={setOpening} kind={openingKind} setKind={setOpeningKind} gate={gate} />
        <CheckListEditor title="Закрытие" type="closing" items={closingItems} value={closing} setValue={setClosing} kind={closingKind} setKind={setClosingKind} gate={gate} />
      </div>
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act("saveGood", { name: good, unit }).then((saved) => {
            if (saved) setGood("");
          });
        }}
      >
        <input className={fieldClass} style={{ maxWidth: 240 }} placeholder="Новый товар" value={good} onChange={(event) => setGood(event.target.value)} required />
        <input className={fieldClass} style={{ maxWidth: 120 }} placeholder="шт." value={unit} onChange={(event) => setUnit(event.target.value)} required />
        <Btn disabled={busy}>Добавить товар</Btn>
      </form>
      <div className="mt-2 grid gap-2">
        {ws.goods.map((item) => (
          <GoodRow key={`${item.id}:${item.name}:${item.unit}`} item={item} gate={gate} />
        ))}
      </div>
    </Card>
  );
}

function GoodRow({ gate, item }: { gate: Gate; item: { id: string; name: string; unit: string } }) {
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={fieldClass} style={{ maxWidth: 240 }} value={name} onChange={(event) => setName(event.target.value)} />
      <input className={fieldClass} style={{ maxWidth: 100 }} value={unit} onChange={(event) => setUnit(event.target.value)} />
      <Btn kind="ghost" disabled={gate.busy} onClick={() => void gate.act("saveGood", { id: item.id, name, unit })}>
        Сохранить
      </Btn>
      <Btn kind="danger" disabled={gate.busy} onClick={() => void gate.act("deleteGood", { id: item.id })}>
        Удалить
      </Btn>
    </div>
  );
}

function CheckListEditor({
  title,
  type,
  items,
  value,
  setValue,
  kind,
  setKind,
  gate,
}: {
  title: string;
  type: "opening" | "closing";
  items: { id: string; text: string; kind: string }[];
  value: string;
  setValue: (value: string) => void;
  kind: string;
  setKind: (value: string) => void;
  gate: Gate;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
      {items.map((item) => (
        <CheckRow key={`${item.id}:${item.text}:${item.kind}`} item={item} type={type} gate={gate} />
      ))}
      <form
        className="mt-2 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void gate.act("saveCheckItem", { type, text: value, kind }).then((saved) => {
            if (saved) setValue("");
          });
        }}
      >
        <input className={fieldClass} placeholder="Новый пункт" value={value} onChange={(event) => setValue(event.target.value)} required />
        <div className="flex flex-wrap gap-2">
          <select className={fieldClass} style={{ maxWidth: 180 }} value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="status">Отметка</option>
            <option value="text">Текст</option>
            <option value="photo">Фото</option>
          </select>
          <Btn disabled={gate.busy}>Добавить</Btn>
        </div>
      </form>
    </div>
  );
}

function CheckRow({
  item,
  type,
  gate,
}: {
  item: { id: string; text: string; kind: string };
  type: "opening" | "closing";
  gate: Gate;
}) {
  const [text, setText] = useState(item.text);
  const [kind, setKind] = useState(item.kind);
  return (
    <div className="mb-2 grid gap-1">
      <input className={fieldClass} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="flex flex-wrap gap-1">
        <select className={fieldClass} style={{ maxWidth: 140 }} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="status">Отметка</option>
          <option value="text">Текст</option>
          <option value="photo">Фото</option>
        </select>
        <Btn kind="ghost" disabled={gate.busy} onClick={() => void gate.act("saveCheckItem", { id: item.id, type, text, kind })}>
          Сохранить
        </Btn>
        <Btn kind="danger" disabled={gate.busy} onClick={() => void gate.act("deleteCheckItem", { id: item.id })}>
          Убрать
        </Btn>
      </div>
    </div>
  );
}

export function ControlPage(gate: Gate) {
  const { ws, pointId, act, busy, setPage, setShiftId } = gate;
  const [month, setMonth] = useState(ws.month);
  const [editing, setEditing] = useState<Shift | null | "new">(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [review, setReview] = useState<string | null>(null);
  const rows = ws.shifts.filter((shift) => shift.pointId === pointId && shift.day.startsWith(month));
  const issues = ws.issues.filter((issue) => issue.pointId === pointId && issue.status !== "Закрыта");
  const requests = ws.replacements.filter((request) => request.pointId === pointId && request.status === "На рассмотрении");
  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Контроль пункта</h1>
          <p className="text-sm text-muted">{pointName(ws, pointId)}. Журнал один на все даты — файл «Журнал-ПВЗ».</p>
        </div>
        {isChief(ws.me.role) ? (
          <Btn
            disabled={busy}
            onClick={async () => {
              const file = await act<{ filename: string; base64: string }>("excel");
              if (file) saveFile(file.filename, file.base64);
            }}
          >
            Скачать актуальный журнал Excel
          </Btn>
        ) : null}
      </header>
      {isChief(ws.me.role) ? <CatalogCard gate={gate} /> : null}
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className={fieldClass} style={{ maxWidth: 180 }} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          <Btn kind="soft" onClick={() => setEditing("new")}>
            Назначить смену
          </Btn>
          <Btn disabled={busy} onClick={() => void act("publishMonth", { month, pointId })}>
            Опубликовать месяц
          </Btn>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2">Дата</th>
                <th>Сотрудник</th>
                <th>Время</th>
                <th>Состояние</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((shift) => (
                <tr key={shift.id} className="border-t border-line">
                  <td className="py-2">{ruDay(shift.day)}</td>
                  <td>{personName(ws, shift.staffId)}</td>
                  <td>
                    {shift.start}–{shift.end}
                  </td>
                  <td>
                    <Badge tone={toneBadge(toneOf(ws, shift))}>{shift.published ? toneWord(toneOf(ws, shift)) : "Черновик"}</Badge>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      <Btn kind="ghost" onClick={() => setEditing(shift)}>
                        Изменить
                      </Btn>
                      <Btn
                        kind="ghost"
                        onClick={() => {
                          setShiftId(shift.id);
                          setPage("opening");
                        }}
                      >
                        Открытие
                      </Btn>
                      <Btn
                        kind="ghost"
                        onClick={() => {
                          setShiftId(shift.id);
                          setPage("closing");
                        }}
                      >
                        Закрытие
                      </Btn>
                      <Btn kind="danger" disabled={busy} onClick={() => void act("removeShift", { id: shift.id })}>
                        Снять
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Проблемы</h2>
        {issues.length === 0 ? <p className="text-sm text-muted">Нет открытых.</p> : null}
        {issues.map((issue) => (
          <div key={issue.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm">
            <p>
              <b>{issue.category}.</b> {issue.body}
            </p>
            <Btn kind="ghost" onClick={() => setClosing(issue.id)}>
              Закрыть
            </Btn>
          </div>
        ))}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Замены</h2>
        {requests.length === 0 ? <p className="text-sm text-muted">Нет запросов.</p> : null}
        {requests.map((request) => (
          <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm">
            <p>
              {personName(ws, request.requesterId)} · {ruDay(request.day)} · {request.reason}
            </p>
            <Btn kind="ghost" onClick={() => setReview(request.id)}>
              Рассмотреть
            </Btn>
          </div>
        ))}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Пожелания сотрудников</h2>
        {ws.prefs.filter((batch) => ws.people.find((person) => person.id === batch.staffId)?.pointIds.includes(pointId)).map((batch) => (
          <p key={`${batch.staffId}-${batch.month}`} className="border-t border-line py-2 text-sm">
            <b>{personName(ws, batch.staffId)}</b> · {batch.month} · {batch.sent ? "отправлено" : "черновик"} ·{" "}
            {batch.days
              .filter((day) => day.status)
              .map((day) => `${day.day}:${PREF_OPTIONS.find((option) => option.value === day.status)?.label ?? day.status}`)
              .join(", ") || "пусто"}
          </p>
        ))}
        <PrefFix gate={gate} />
      </Card>
      {editing ? <ShiftModal gate={gate} shift={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {closing ? (
        <Modal title="Закрыть проблему" onClose={() => setClosing(null)}>
          <Field label="Как решили">
            <textarea className={areaClass} value={resolution} onChange={(event) => setResolution(event.target.value)} />
          </Field>
          <Btn
            disabled={busy}
            onClick={async () => {
              const done = await act("closeIssue", { id: closing, resolution });
              if (done) setClosing(null);
            }}
          >
            Закрыть
          </Btn>
        </Modal>
      ) : null}
      {review ? <ReviewModal gate={gate} id={review} onClose={() => setReview(null)} /> : null}
    </div>
  );
}

function ShiftModal({ gate, shift, onClose }: { gate: Gate; shift: Shift | null; onClose: () => void }) {
  const hours = (id: string) => {
    const point = gate.ws.points.find((item) => item.id === id);
    return { start: point?.opens ?? "09:00", end: point?.closes ?? "21:00" };
  };
  const initial = hours(shift?.pointId ?? gate.pointId);
  const [day, setDay] = useState(shift?.day ?? gate.ws.today);
  const [pointId, setPointId] = useState(shift?.pointId ?? gate.pointId);
  const [staffId, setStaffId] = useState(shift?.staffId ?? "");
  const [start, setStart] = useState(shift?.start ?? initial.start);
  const [end, setEnd] = useState(shift?.end ?? initial.end);
  const [overlapReason, setOverlapReason] = useState(shift?.overlapReason ?? "");
  const staff = peopleOnPoint(gate, pointId);
  return (
    <Modal title={shift ? "Изменить смену" : "Назначить смену"} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const saved = await gate.act("saveShift", { id: shift?.id, day, pointId, staffId, start, end, overlapReason });
          if (saved) onClose();
        }}
      >
        <Field label="Дата">
          <input className={fieldClass} type="date" value={day} onChange={(event) => setDay(event.target.value)} required />
        </Field>
        <Field label="Пункт">
          <select
            className={fieldClass}
            value={pointId}
            onChange={(event) => {
              const next = event.target.value;
              setPointId(next);
              if (!shift) {
                const time = hours(next);
                setStart(time.start);
                setEnd(time.end);
              }
            }}
          >
            {gate.ws.points.map((point) => (
              <option key={point.id} value={point.id}>
                {point.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Сотрудник">
          <select className={fieldClass} value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
            <option value="">Выберите</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Начало смены, когда её нужно открыть">
            <input className={fieldClass} type="time" value={start} onChange={(event) => setStart(event.target.value)} required />
          </Field>
          <Field label="Конец смены, когда её нужно закрыть">
            <input className={fieldClass} type="time" value={end} onChange={(event) => setEnd(event.target.value)} required />
          </Field>
        </div>
        <Field label="Причина, если в этот день уже есть смена">
          <textarea className={areaClass} value={overlapReason} onChange={(event) => setOverlapReason(event.target.value)} />
        </Field>
        <Btn disabled={gate.busy}>Сохранить</Btn>
      </form>
    </Modal>
  );
}

function ReviewModal({ gate, id, onClose }: { gate: Gate; id: string; onClose: () => void }) {
  const request = gate.ws.replacements.find((item) => item.id === id);
  const [replacementId, setReplacementId] = useState(request?.replacementId ?? "");
  const [reason, setReason] = useState("");
  if (!request) return null;
  const staff = peopleOnPoint(gate, request.pointId).filter((person) => person.id !== request.requesterId);
  const named = request.replacementId ? personName(gate.ws, request.replacementId) : "";
  return (
    <Modal title="Замена" onClose={onClose}>
      <p className="mb-3 text-sm">
        {personName(gate.ws, request.requesterId)} · {request.reason}
        {named ? ` · предложено: ${named}` : ""}
      </p>
      {request.replacementId ? null : (
        <Field label="Кто выйдет">
          <select className={fieldClass} value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
            <option value="">Выберите</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Решение, если у человека уже есть смена">
        <textarea className={areaClass} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Btn
          disabled={gate.busy}
          onClick={async () => {
            const done = await gate.act("reviewReplacement", { id, approve: true, replacementId, reason });
            if (done) onClose();
          }}
        >
          Подтвердить
        </Btn>
        <Btn
          kind="danger"
          disabled={gate.busy}
          onClick={async () => {
            const done = await gate.act("reviewReplacement", { id, approve: false });
            if (done) onClose();
          }}
        >
          Отклонить
        </Btn>
      </div>
    </Modal>
  );
}

function PrefFix({ gate }: { gate: Gate }) {
  const [staffId, setStaffId] = useState("");
  const [day, setDay] = useState("1");
  const [status, setStatus] = useState("work");
  const [comment, setComment] = useState("");
  const month = gate.ws.nextMonth;
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void gate.act("editPref", { staffId, month, day: Number(day), status, comment });
      }}
    >
      <p className="mb-2 text-sm font-medium">Исправить день {monthTitle(month)}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <select className={fieldClass} value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
          <option value="">Сотрудник</option>
          {peopleOnPoint(gate, gate.pointId).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        <input className={fieldClass} type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} />
        <select className={fieldClass} value={status} onChange={(event) => setStatus(event.target.value)}>
          {PREF_OPTIONS.filter((option) => option.value).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input className={fieldClass} placeholder="Комментарий" value={comment} onChange={(event) => setComment(event.target.value)} />
      </div>
      <Btn className="mt-2" kind="ghost" disabled={gate.busy}>
        Записать
      </Btn>
    </form>
  );
}

export function StaffPage(gate: Gate) {
  const { ws, act, busy } = gate;
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Staff | "new" | null>(null);
  const [appUrl, setAppUrl] = useState(ws.miniAppUrl);
  const chief = isChief(ws.me.role);
  const owner = ws.me.role === "owner";
  const codeOwner = configuredOwnerUsername();
  const list = ws.people.filter((person) => {
    if (!person.active) return false;
    if (!chief && person.role !== "employee") return false;
    const hay = `${person.name} ${person.username} ${person.phone} ${person.pointIds.map((id) => pointName(ws, id)).join(" ")}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });
  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{chief ? "Люди и роли" : "Сотрудники"}</h1>
          <p className="text-sm text-muted">Вход только по юзернейму из этого списка. Случайный человек сам не зарегистрируется.</p>
        </div>
        <Btn onClick={() => setEdit("new")}>Добавить</Btn>
      </header>
      {owner ? (
        <Card>
          <h2 className="font-semibold">Бот и мини-приложение</h2>
          <p className="mt-1 text-sm text-muted">
            Бот: {ws.botUsername ? `@${ws.botUsername}` : "ещё подключается"}. Главный администратор в коде:{" "}
            {codeOwner ? `@${codeOwner}` : "не указан"}.
          </p>
          <p className="mt-1 text-sm text-muted">
            {ws.miniAppUrl ? `Кнопка «Кабинет» открывает ${ws.miniAppUrl}.` : "Адрес мини-приложения ещё не подключён."}
          </p>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void act("bindMiniApp", { url: appUrl });
            }}
          >
            <input
              className={fieldClass}
              placeholder="https://адрес-после-публикации"
              value={appUrl}
              onChange={(event) => setAppUrl(event.target.value)}
            />
            <Btn disabled={busy}>Подключить бота</Btn>
          </form>
          <p className="mt-2 text-xs text-muted">
            Вставляйте адрес только после публикации кабинета. Бот поставит кнопку «Кабинет» и будет присылать сообщения на этот сайт, даже когда ваш компьютер выключен.
          </p>
          <p className="mt-2 text-xs text-muted">
            Чтобы напоминания уходили сами, даже если никто не открывает кабинет, на сайте cron-job.org создайте задачу: каждую минуту открывать адрес вашего сайта с окончанием /api/cron и заголовком x-cron-secret. Секрет: {ws.cronSecret}
          </p>
        </Card>
      ) : null}
      {!codeOwner ? (
        <Card>
          <p className="text-sm">
            Главный администратор ещё не назначен. Роли руководителя и администратора из кабинета выдать нельзя — юзернейм записывается в коде бота.
          </p>
        </Card>
      ) : null}
      <input className={fieldClass} placeholder="Поиск по имени, Telegram ID или пункту" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Card>
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2">Имя</th>
                <th>Telegram ID</th>
                <th>Роль</th>
                <th>Бот</th>
                <th>Пункты</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((person) => (
                <tr key={person.id} className="border-t border-line">
                  <td className="py-3">
                    <b>{person.name}</b>
                    <div className="text-muted">{person.phone || "телефон не указан"}</div>
                  </td>
                  <td>@{person.username}</td>
                  <td>{roleLabel(person.role)}</td>
                  <td>{person.botLinked ? "на связи" : "нет /start"}</td>
                  <td>{person.role === "employee" ? person.pointIds.map((id) => pointName(ws, id)).join(", ") : "Все пункты"}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {owner || person.role === "employee" || person.id === ws.me.id ? (
                        <Btn kind="ghost" onClick={() => setEdit(person)}>
                          Изменить
                        </Btn>
                      ) : null}
                      {canRemove(ws.me, person) ? (
                        <Btn
                          kind="danger"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`Закрыть доступ для ${person.name}? История смен сохранится.`)) void act("deleteStaff", { id: person.id });
                          }}
                        >
                          Удалить
                        </Btn>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit ? <StaffModal gate={gate} person={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

function canRemove(actor: Staff, person: Staff) {
  if (person.id === actor.id || person.role === "owner") return false;
  if (actor.role === "owner") return true;
  return actor.role === "director" && (person.role === "employee" || person.role === "manager");
}

function StaffModal({ gate, person, onClose }: { gate: Gate; person: Staff | null; onClose: () => void }) {
  const owner = gate.ws.me.role === "owner";
  const lockedOwner = person?.role === "owner";
  const [name, setName] = useState(person?.name ?? "");
  const [username, setUsername] = useState(person?.username ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [role, setRole] = useState(person?.role === "director" || person?.role === "manager" ? person.role : "employee");
  const [points, setPoints] = useState<string[]>(person?.pointIds ?? [gate.pointId]);
  const shownRole = lockedOwner ? "owner" : owner ? role : (person?.role ?? "employee");
  return (
    <Modal title={person ? "Изменить человека" : "Новый сотрудник"} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const saved = await gate.act("saveStaff", {
            id: person?.id,
            name,
            username,
            phone,
            role: lockedOwner ? "owner" : role,
            pointIds: points,
          });
          if (saved) onClose();
        }}
      >
        <Field label="Имя и фамилия">
          <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Telegram ID">
          <input
            className={fieldClass}
            value={username}
            placeholder="@username"
            disabled={lockedOwner}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
          <span className="text-xs font-normal text-muted">
            {lockedOwner
              ? "Юзернейм главного администратора меняется только в коде бота."
              : "Сюда пишется юзернейм, не числовой id. Человек входит им и нажимает /start у бота."}
          </span>
        </Field>
        <Field label="Телефон">
          <input className={fieldClass} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7 900 000-00-00" />
        </Field>
        {owner && !lockedOwner ? (
          <Field label="Роль">
            <select className={fieldClass} value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="employee">Сотрудник</option>
              <option value="manager">Администратор</option>
              <option value="director">Руководитель</option>
            </select>
          </Field>
        ) : (
          <p className="mb-3 text-sm text-muted">
            {lockedOwner
              ? "Это главный администратор. Роль передаётся только правкой кода бота."
              : "Роль администратора и руководителя назначает главный администратор."}
          </p>
        )}
        {shownRole === "employee" ? (
          <fieldset className="mb-3 rounded-control border border-line p-3">
            <legend className="px-1 text-sm font-medium">Пункты</legend>
            <div className="max-h-56 overflow-auto">
              {gate.ws.points.map((point) => (
                <label key={point.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={points.includes(point.id)}
                    onChange={(event) =>
                      setPoints((list) => (event.target.checked ? [...list, point.id] : list.filter((id) => id !== point.id)))
                    }
                  />
                  {point.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="mb-3 text-sm text-muted">Администратору и руководителю доступны все пункты.</p>
        )}
        <Btn disabled={gate.busy}>Сохранить</Btn>
      </form>
    </Modal>
  );
}

export function PointsPage(gate: Gate) {
  const { ws, act, busy, pointId } = gate;
  const chief = isChief(ws.me.role);
  const [name, setName] = useState("");
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Пункты сети</h1>
        <p className="text-sm text-muted">
          {chief
            ? "У каждой точки свои часы. Начало — когда смену нужно открыть, конец — когда закрыть. Будущие ещё не открытые смены этой точки перестроятся сами."
            : "Список сети. Часы точки меняет руководитель."}
        </p>
      </header>
      {chief ? (
        <Card>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act("savePoint", { name, opens: "09:00", closes: "21:00" }).then((saved) => {
                if (saved) setName("");
              });
            }}
          >
            <input className={fieldClass} style={{ maxWidth: 420 }} placeholder="Название нового пункта" value={name} onChange={(event) => setName(event.target.value)} required />
            <Btn disabled={busy}>Добавить пункт</Btn>
          </form>
        </Card>
      ) : null}
      {ws.points.map((point) => (
        <PointHours key={point.id} gate={gate} point={point} current={point.id === pointId} chief={chief} />
      ))}
    </div>
  );
}

function PointHours({
  gate,
  point,
  current,
  chief,
}: {
  gate: Gate;
  point: { id: string; name: string; opens: string; closes: string };
  current: boolean;
  chief: boolean;
}) {
  const [name, setName] = useState(point.name);
  const [opens, setOpens] = useState(point.opens);
  const [closes, setCloses] = useState(point.closes);
  if (!chief) {
    return (
      <Card>
        <p className="font-semibold">
          {point.name}
          {current ? " · выбран" : ""}
        </p>
        <p className="mt-1 text-sm text-muted">
          Открыть в {point.opens}, закрыть в {point.closes}
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void gate.act("savePoint", { id: point.id, name, opens, closes });
        }}
      >
        <Field label={current ? "Название · выбранный пункт" : "Название"}>
          <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Начало: когда открыть смену">
            <input className={fieldClass} type="time" value={opens} onChange={(event) => setOpens(event.target.value)} required />
          </Field>
          <Field label="Конец: когда закрыть смену">
            <input className={fieldClass} type="time" value={closes} onChange={(event) => setCloses(event.target.value)} required />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn disabled={gate.busy}>Сохранить часы</Btn>
          <Btn
            kind="danger"
            disabled={gate.busy}
            onClick={() => {
              if (confirm(`Удалить пункт «${point.name}»?`)) void gate.act("deletePoint", { id: point.id });
            }}
          >
            Удалить
          </Btn>
        </div>
      </form>
    </Card>
  );
}
