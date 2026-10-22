-- У каждой точки своё время открытия и закрытия. Новые смены берут его отсюда.
alter table points add column if not exists opens_at text not null default '09:00';
alter table points add column if not exists closes_at text not null default '21:00';
