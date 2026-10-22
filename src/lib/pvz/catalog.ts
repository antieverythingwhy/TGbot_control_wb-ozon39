// Пункты чек-листа. Это рабочий набор кабинета, не утверждённая инструкция маркетплейса.
// kind: status — только результат; text — обязательный комментарий; photo — обязательное фото.

export type ItemKind = "status" | "text" | "photo";

export type CheckItem = { id: string; text: string; kind: ItemKind };

export const OPENING: CheckItem[] = [
  { id: "o1", text: "Чистота пола и проходов", kind: "status" },
  { id: "o2", text: "Порядок в клиентской зоне", kind: "status" },
  { id: "o3", text: "Порядок в зоне хранения", kind: "status" },
  { id: "o4", text: "Оборудование и интернет исправны", kind: "status" },
  { id: "o5", text: "Чистота примерочных", kind: "status" },
];

export const CLOSING: CheckItem[] = [
  { id: "c1", text: "Клиентская зона убрана", kind: "status" },
  { id: "c2", text: "Рабочее место приведено в порядок", kind: "status" },
  { id: "c3", text: "Зона хранения и проходы в порядке", kind: "status" },
  { id: "c4", text: "Нерешённые вопросы переданы", kind: "text" },
  { id: "c5", text: "Фото порядка в помещении", kind: "photo" },
];

export const ZONES = ["Клиентская зона", "Рабочее место", "Зона хранения"];

export const ISSUE_CATEGORIES = [
  "Оборудование",
  "Чистота и порядок",
  "Отправление",
  "Расходные материалы",
  "Другая ситуация",
];

export const PRIORITIES = ["Обычная", "Важная", "Критическая"];

export const PREF_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Не указано" },
  { value: "work", label: "Хочу работать" },
  { value: "off", label: "Выходной" },
  { value: "unavailable", label: "Недоступен" },
  { value: "vacation", label: "Прошу отпуск" },
  { value: "sick", label: "Сообщаю о болезни" },
];

export function itemsFor(type: "opening" | "closing"): CheckItem[] {
  return type === "opening" ? OPENING : CLOSING;
}

export function statusLabel(status: string): string {
  if (status === "ok") return "В порядке";
  if (status === "problem") return "Есть проблема";
  if (status === "na") return "Не относится к этому ПВЗ";
  return "Не заполнено";
}
