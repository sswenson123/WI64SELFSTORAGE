-- WI 64 Self Storage — move-out requests.
-- Two request types share one table; the type column decides which columns apply.
--   SCHEDULED_MOVE_OUT : name, phone, planned_move_out_date
--   COMPLETED_MOVE_OUT : unit_number, phone, confirmations, photos, completed_at
-- No tenant/customer identifiers are stored: nothing here is verified against a
-- rent roll yet. See docs — the rent-roll match is deliberately future work.

CREATE TABLE move_out_requests (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL CHECK (type IN ('SCHEDULED_MOVE_OUT','COMPLETED_MOVE_OUT')),
  status                TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','REVIEWED','COMPLETED')),
  facility              TEXT NOT NULL,

  -- contact (both types)
  phone                 TEXT NOT NULL,      -- E.164-ish digits, normalised on write
  phone_display         TEXT NOT NULL,      -- as the customer typed it

  -- SCHEDULED_MOVE_OUT
  customer_name         TEXT,
  planned_move_out_date TEXT,               -- ISO yyyy-mm-dd, customer's intent

  -- COMPLETED_MOVE_OUT
  unit_number           TEXT,
  completed_at          TEXT,               -- server clock, authoritative move-out moment
  confirmed_empty       INTEGER,
  confirmed_swept       INTEGER,
  confirmed_lock_removed INTEGER,

  -- audit
  idempotency_key       TEXT NOT NULL,
  submitted_at          TEXT NOT NULL,      -- server clock
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  staff_note            TEXT,
  user_agent            TEXT,

  CONSTRAINT scheduled_fields CHECK (
    type <> 'SCHEDULED_MOVE_OUT'
    OR (customer_name IS NOT NULL AND planned_move_out_date IS NOT NULL)
  ),
  CONSTRAINT completed_fields CHECK (
    type <> 'COMPLETED_MOVE_OUT'
    OR (unit_number IS NOT NULL AND completed_at IS NOT NULL
        AND confirmed_empty = 1 AND confirmed_swept = 1 AND confirmed_lock_removed = 1)
  )
);

-- One row per submission attempt: a retried tap returns the original record.
CREATE UNIQUE INDEX idx_move_out_idempotency ON move_out_requests (idempotency_key);
CREATE INDEX idx_move_out_type_status ON move_out_requests (type, status, submitted_at DESC);
CREATE INDEX idx_move_out_submitted ON move_out_requests (submitted_at DESC);
-- Supports the future rent-roll match (phone -> tenant, unit -> rental).
CREATE INDEX idx_move_out_phone ON move_out_requests (phone);
CREATE INDEX idx_move_out_unit ON move_out_requests (unit_number);

-- Photos are uploaded one at a time before the final submit, so a row exists
-- before request_id is known. request_id is filled in when the submission lands;
-- rows still NULL after a while are abandoned uploads and can be swept up.
CREATE TABLE move_out_photos (
  id            TEXT PRIMARY KEY,
  request_id    TEXT REFERENCES move_out_requests(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL CHECK (slot IN ('INSIDE','FLOOR','DOOR','EXTRA')),
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  upload_token  TEXT NOT NULL,   -- ties loose uploads to one browser session
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_photos_request ON move_out_photos (request_id);
CREATE INDEX idx_photos_token ON move_out_photos (upload_token);

-- Notification intent is recorded even though no SMS provider is wired up yet.
-- A provider drains this table later; nothing here sends anything today.
CREATE TABLE notification_outbox (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES move_out_requests(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL DEFAULT 'SMS' CHECK (channel IN ('SMS','EMAIL')),
  recipient    TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  provider     TEXT,
  provider_ref TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_outbox_status ON notification_outbox (status, created_at);
