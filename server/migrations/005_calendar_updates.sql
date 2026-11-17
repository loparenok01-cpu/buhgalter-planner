-- Индекс журнала обновлений календаря: записи показываются по времени
-- применения (раздел 6.12, FR-79). Сама таблица calendar_updates создана
-- миграцией 001_init.sql.

CREATE INDEX idx_calendar_updates_applied_at ON calendar_updates (applied_at);
