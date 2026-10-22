-- Главный администратор и привязка личного чата Telegram.
-- Роль owner в кабинете не назначается: её выставляет код при входе (owner.ts).

alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('employee', 'manager', 'director', 'owner'));

alter table staff add column if not exists telegram_chat_id text;
