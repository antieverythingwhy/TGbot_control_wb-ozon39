// Общие типы кабинета. Их видят и сервер, и интерфейс.

export type Role = "employee" | "manager" | "director" | "owner";

export type Staff = {
  id: string;
  name: string;
  role: Role;
  username: string;
  phone: string;
  active: boolean;
  pointIds: string[];
  /** Человек нажал /start у бота, личный чат известен. */
  botLinked: boolean;
};

export type Point = { id: string; name: string; sort: number; opens: string; closes: string };

export type Shift = {
  id: string;
  day: string;
  pointId: string;
  staffId: string;
  start: string;
  end: string;
  published: boolean;
  confirmed: boolean;
  overlapReason: string;
};

/** Итог открытия для календаря: green — смена открыта, red — прошло 15 минут и не открыта. */
export type OpenTone = "green" | "red" | "idle" | "wait";

export type RunBrief = {
  shiftId: string;
  type: "opening" | "closing";
  startedAt: string | null;
  finishedAt: string | null;
  finishedBy: string | null;
  problems: number;
};

export type IssueRow = {
  id: string;
  pointId: string;
  staffId: string;
  category: string;
  body: string;
  priority: string;
  status: string;
  resolution: string;
  hasPhoto: boolean;
  createdAt: string;
};

export type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

export type Replacement = {
  id: string;
  shiftId: string;
  pointId: string;
  day: string;
  requesterId: string;
  reason: string;
  comment: string;
  status: string;
  replacementId: string | null;
  /** Смена коллеги, которую отдают взамен. Пусто — коллега просто выходит вместо просящего. */
  counterShiftId: string | null;
};

export type PrefDay = { day: number; status: string; comment: string };
export type PrefBatch = { staffId: string; month: string; sent: boolean; days: PrefDay[] };

export type Good = { id: string; name: string; unit: string };
export type CheckTemplate = { id: string; type: "opening" | "closing"; text: string; kind: string; sort: number };
export type SupplyItem = { good: string; name: string; unit: string; quantity: string };
export type SupplyDraft = {
  id: string;
  pointId: string;
  staffId: string;
  items: SupplyItem[];
  comment: string;
  updatedAt: string | null;
};
export type SupplyReport = {
  id: string;
  shiftId: string;
  pointId: string;
  staffId: string;
  items: SupplyItem[];
  comment: string;
  status: string;
  createdAt: string;
};
export type Delivery = {
  id: string;
  pointId: string;
  goodId: string;
  name: string;
  unit: string;
  quantity: number;
  day: string;
  comment: string;
  actorId: string;
};

export type Workspace = {
  me: Staff;
  today: string;
  month: string;
  nextMonth: string;
  wishesLocked: boolean;
  nowLabel: string;
  points: Point[];
  people: Staff[];
  shifts: Shift[];
  runs: RunBrief[];
  issues: IssueRow[];
  notices: Notice[];
  unread: number;
  replacements: Replacement[];
  prefs: PrefBatch[];
  goods: Good[];
  checks: CheckTemplate[];
  drafts: SupplyDraft[];
  reports: SupplyReport[];
  deliveries: Delivery[];
  /** Юзернейм бота без @. Пусто, пока Telegram не ответил. */
  botUsername: string;
  /** Юзернейм главного администратора из кода. Пусто, пока его не записали. */
  ownerUsername: string;
  /** Адрес мини-приложения, если его уже подключили. */
  miniAppUrl: string;
  /** Секрет будильника. Пустой у всех, кроме главного администратора. */
  cronSecret: string;
};

export type Answer = {
  itemId: string;
  text: string;
  kind: string;
  status: string;
  comment: string;
  priority: string;
  photo: string;
};

export type Checklist = {
  shift: Shift;
  type: "opening" | "closing";
  locked: boolean;
  lockReason: string;
  canFinish: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  finishedByName: string | null;
  answers: Answer[];
  zones: { zone: string; photo: string }[];
  history: { text: string; actor: string; at: string }[];
  tone: OpenTone;
};

export function roleLabel(role: Role): string {
  if (role === "owner") return "Главный администратор";
  if (role === "director") return "Руководитель";
  if (role === "manager") return "Администратор";
  return "Сотрудник";
}

export function isLeader(role: Role): boolean {
  return role !== "employee";
}

/** Руководитель и главный администратор: пункты, поставки, журнал, удаление людей. */
export function isChief(role: Role): boolean {
  return role === "director" || role === "owner";
}
