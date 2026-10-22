-- Справочники ПВЗ, люди и их права, смены, чек-листы, уведомления бота.
-- Роли: employee (сотрудник), manager (управляющий), director (руководитель).
-- Саморегистрации нет: войти можно только по юзернейму, который уже лежит в staff.

create table if not exists staff (
  id text primary key,
  name text not null,
  role text not null check (role in ('employee', 'manager', 'director')),
  -- Хранится юзернейм без @, в нижнем регистре. Подпись в форме — «Telegram ID».
  telegram_username text not null unique,
  phone text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists points (
  id text primary key,
  name text not null,
  sort int not null,
  active boolean not null default true
);

-- Закрепление сотрудника за пунктами. Управляющий и руководитель видят все пункты без строк здесь.
create table if not exists staff_points (
  staff_id text not null references staff(id) on delete cascade,
  point_id text not null references points(id) on delete cascade,
  primary key (staff_id, point_id)
);

create table if not exists shifts (
  id text primary key,
  day date not null,
  point_id text not null references points(id),
  staff_id text not null references staff(id),
  start_time text not null,
  end_time text not null,
  published boolean not null default false,
  confirmed boolean not null default false,
  overlap_reason text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists shifts_day_idx on shifts (day);
create index if not exists shifts_staff_idx on shifts (staff_id);

create table if not exists checklist_runs (
  id text primary key,
  shift_id text not null references shifts(id) on delete cascade,
  type text not null check (type in ('opening', 'closing')),
  started_at timestamptz,
  finished_at timestamptz,
  started_by text,
  finished_by text,
  unique (shift_id, type)
);

-- Снимок пункта на момент проверки: правка шаблона не переписывает историю.
create table if not exists checklist_answers (
  run_id text not null references checklist_runs(id) on delete cascade,
  item_id text not null,
  item_text text not null,
  kind text not null,
  status text not null default '',
  comment text not null default '',
  priority text not null default '',
  photo text not null default '',
  primary key (run_id, item_id)
);

create table if not exists zone_photos (
  run_id text not null references checklist_runs(id) on delete cascade,
  zone text not null,
  photo text not null default '',
  primary key (run_id, zone)
);

create table if not exists preference_batches (
  staff_id text not null references staff(id) on delete cascade,
  month text not null,
  sent boolean not null default false,
  primary key (staff_id, month)
);

create table if not exists preferences (
  staff_id text not null references staff(id) on delete cascade,
  month text not null,
  day int not null,
  status text not null default '',
  comment text not null default '',
  primary key (staff_id, month, day)
);

create table if not exists replacements (
  id text primary key,
  shift_id text not null references shifts(id) on delete cascade,
  point_id text not null,
  day date not null,
  requester_id text not null references staff(id),
  reason text not null,
  comment text not null default '',
  status text not null default 'На рассмотрении',
  replacement_id text,
  created_at timestamptz not null default now()
);

create table if not exists issues (
  id text primary key,
  point_id text not null,
  staff_id text not null references staff(id),
  shift_id text,
  category text not null,
  body text not null,
  priority text not null,
  photo text not null default '',
  status text not null default 'Новая',
  resolution text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists supply_goods (
  id text primary key,
  name text not null,
  unit text not null,
  sort int not null
);

create table if not exists supply_drafts (
  id text primary key,
  point_id text not null,
  staff_id text not null,
  items_json text not null default '{}',
  comment text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists supply_reports (
  id text primary key,
  shift_id text not null unique,
  point_id text not null,
  staff_id text not null,
  items_json text not null default '[]',
  comment text not null default '',
  status text not null default 'Новая',
  created_at timestamptz not null default now()
);

create table if not exists supply_deliveries (
  id text primary key,
  point_id text not null,
  good_id text not null,
  name text not null,
  unit text not null,
  quantity int not null,
  day date not null,
  comment text not null default '',
  actor_id text not null,
  created_at timestamptz not null default now()
);

-- Журнал бота. Каждая строка адресована конкретному человеку.
create table if not exists notifications (
  id text primary key,
  recipient_id text not null,
  kind text not null,
  title text not null,
  body text not null,
  read boolean not null default false,
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_idx on notifications (recipient_id, created_at desc);

create table if not exists sessions (
  token text primary key,
  staff_id text not null references staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists audit_log (
  id text primary key,
  actor_id text,
  actor_name text not null,
  entity text not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- Одноразовые служебные флаги. Учебные люди и смены в этот файл не входят:
-- пустой запуск остаётся без демо-профилей, пример лежит отдельно в 0005_demo.sql.
create table if not exists app_flags (
  key text primary key,
  value text not null
);

insert into points (id, name, sort) values
  ('p01', 'Калининград_517 (Приголье)', 1),
  ('p02', 'Калининград_635 (Еловая)', 2),
  ('p03', 'Калининград_655 (Лукашева)', 3),
  ('p04', 'Калининград_640 (Горького)', 4),
  ('p05', 'Калининград_641 (Согласия)', 5),
  ('p06', 'Калининград_642 (Ростовская)', 6),
  ('p07', 'Калининград_647 (СНТ Победа)', 7),
  ('p08', 'Калининград_672 (Гайдара)', 8),
  ('p09', 'Зеленоградск_27 (Центральная)', 9),
  ('p10', 'Зеленоградск_34 (Победа)', 10),
  ('p11', 'Зеленоградск_35 (Ткаченко)', 11),
  ('p12', 'Янтарный_12 (Советская)', 12),
  ('p13', 'WB Артиллерийская', 13),
  ('p14', 'WB Ростовская', 14),
  ('p15', 'WB Бровцева', 15)
on conflict (id) do nothing;

insert into supply_goods (id, name, unit, sort) values
  ('knife', 'Нож', 'шт.', 1),
  ('scissors', 'Ножницы', 'шт.', 2),
  ('toilet-paper', 'Туалетная бумага', 'рулон', 3)
on conflict (id) do nothing;
