-- Начальная схема базы данных.
-- Физическая схема описана в ТЗ_MVP.md, раздел 5.2.
-- Даты хранятся текстом в ISO 8601 YYYY-MM-DD (NFR-08), суммы — целыми рублями (FR-66).

CREATE TABLE clients (
  id                  TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL,
  inn                 TEXT    NOT NULL,
  form                TEXT    NOT NULL CHECK (form IN ('ООО', 'ИП')),
  sno                 TEXT    NOT NULL CHECK (sno IN ('ОСНО', 'УСН', 'ЕСХН', 'ПСН', 'НПД', 'АУСН')),
  vat                 INTEGER NOT NULL DEFAULT 0 CHECK (vat IN (0, 1)),
  vat_rate            INTEGER CHECK (vat_rate IN (0, 5, 7, 10, 22)),
  profit_advances     TEXT    NOT NULL DEFAULT 'none' CHECK (profit_advances IN ('none', 'quarterly', 'monthly')),
  vat_exempt          INTEGER NOT NULL DEFAULT 0 CHECK (vat_exempt IN (0, 1)),
  has_employees       INTEGER NOT NULL DEFAULT 0 CHECK (has_employees IN (0, 1)),
  has_land_tax        INTEGER NOT NULL DEFAULT 0 CHECK (has_land_tax IN (0, 1)),
  has_property_tax    INTEGER NOT NULL DEFAULT 0 CHECK (has_property_tax IN (0, 1)),
  has_transport_tax   INTEGER NOT NULL DEFAULT 0 CHECK (has_transport_tax IN (0, 1)),
  pinned              INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE INDEX idx_clients_view ON clients (archived, sort_order, name);
CREATE INDEX idx_clients_inn  ON clients (inn);

-- Пользовательские признаки из поля «Дополнительно» (FR-15). На правила не влияют (FR-16).
CREATE TABLE client_flags (
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  value     TEXT NOT NULL,
  PRIMARY KEY (client_id, value)
);

CREATE TABLE tasks (
  id             TEXT    PRIMARY KEY,
  client_id      TEXT    NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  date           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done', 'sent')),
  comment        TEXT    NOT NULL DEFAULT '',
  origin         TEXT    NOT NULL CHECK (origin IN ('rule', 'template', 'manual')),
  rule_id        TEXT,
  depends_on     TEXT    REFERENCES tasks (id) ON DELETE SET NULL,
  payment_filled INTEGER NOT NULL DEFAULT 0 CHECK (payment_filled IN (0, 1))
);

CREATE INDEX idx_tasks_client_date ON tasks (client_id, date);
CREATE INDEX idx_tasks_date        ON tasks (date);
CREATE INDEX idx_tasks_status      ON tasks (status);

-- Защита от дублей при повторной генерации (FR-24): клиент + дата + правило.
CREATE UNIQUE INDEX idx_tasks_rule_unique
  ON tasks (client_id, date, rule_id)
  WHERE rule_id IS NOT NULL;

-- Состав уведомления без сумм: суммы живут только в реестре платежей (FR-36).
CREATE TABLE task_tax_lines (
  task_id  TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  tax_kind TEXT NOT NULL,
  PRIMARY KEY (task_id, tax_kind)
);

CREATE TABLE payments (
  id           TEXT    PRIMARY KEY,
  client_id    TEXT    NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  payment_date TEXT    NOT NULL,
  task_id      TEXT    REFERENCES tasks (id) ON DELETE SET NULL,
  comment      TEXT    NOT NULL DEFAULT '',
  manual       INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1))
);

CREATE INDEX idx_payments_client_date ON payments (client_id, payment_date);
CREATE INDEX idx_payments_date        ON payments (payment_date);

CREATE TABLE payment_lines (
  id          TEXT    PRIMARY KEY,
  payment_id  TEXT    NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  tax_kind    TEXT    NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  source      TEXT    NOT NULL CHECK (source IN ('notification', 'declaration', 'manual')),
  filing_date TEXT
);

CREATE INDEX idx_payment_lines_payment ON payment_lines (payment_id);
CREATE INDEX idx_payment_lines_tax     ON payment_lines (tax_kind);

CREATE TABLE templates (
  id      TEXT    PRIMARY KEY,
  title   TEXT    NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))
);

CREATE TABLE checklists (
  id    TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE checklist_items (
  id          TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklists (id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  date        TEXT
);

CREATE INDEX idx_checklist_items ON checklist_items (checklist_id);

-- Настройки вида: ui.weekStart, ui.mode (FR-52).
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Единственная учётная запись бухгалтера (FR-69). Пароль хранится только хешем.
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Журнал обновлений календаря нерабочих дней (раздел 6.12).
CREATE TABLE calendar_updates (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  source_a   TEXT NOT NULL DEFAULT '',
  source_b   TEXT NOT NULL DEFAULT '',
  years      TEXT NOT NULL DEFAULT '',
  checksum   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
  note       TEXT NOT NULL DEFAULT ''
);
