-- Уточнение даты внутри периода (дополнение к FR-42).
--
-- Положение даты period_pos дополняется вариантами «число месяца»
-- и «день недели»: period_day хранит либо число месяца (1–31),
-- либо день недели (0 — понедельник … 6 — воскресенье).
--
-- period_pos = 'start' | 'middle' | 'end'      → period_day не используется.
-- period_pos = 'dayOfMonth'                    → period_day = 1…31.
-- period_pos = 'weekday'                       → period_day = 0…6.

ALTER TABLE checklist_items ADD COLUMN period_day INTEGER;
