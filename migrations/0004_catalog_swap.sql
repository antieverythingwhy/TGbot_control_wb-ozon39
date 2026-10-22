-- Пункты открытия и закрытия живут в базе: руководитель правит их из кабинета.
-- В замене хранится, чью смену предлагают взамен.

create table if not exists checklist_items (
  id text primary key,
  type text not null check (type in ('opening', 'closing')),
  text text not null,
  kind text not null check (kind in ('status', 'text', 'photo')),
  sort int not null default 0,
  active boolean not null default true
);

insert into checklist_items (id, type, text, kind, sort) values
  ('o1', 'opening', 'Чистота пола и проходов', 'status', 1),
  ('o2', 'opening', 'Порядок в клиентской зоне', 'status', 2),
  ('o3', 'opening', 'Порядок в зоне хранения', 'status', 3),
  ('o4', 'opening', 'Оборудование и интернет исправны', 'status', 4),
  ('o5', 'opening', 'Чистота примерочных', 'status', 5),
  ('c1', 'closing', 'Клиентская зона убрана', 'status', 1),
  ('c2', 'closing', 'Рабочее место приведено в порядок', 'status', 2),
  ('c3', 'closing', 'Зона хранения и проходы в порядке', 'status', 3),
  ('c4', 'closing', 'Нерешённые вопросы переданы', 'text', 4),
  ('c5', 'closing', 'Фото порядка в помещении', 'photo', 5)
on conflict (id) do nothing;

alter table replacements add column if not exists counter_shift_id text;
alter table checklist_answers add column if not exists sort int not null default 0;
