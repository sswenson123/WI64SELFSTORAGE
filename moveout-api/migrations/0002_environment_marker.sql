-- Marks which environment a record came from, so preview/test submissions can
-- never be mistaken for real ones in the admin queue or in a later export.
-- Existing rows predate the preview Worker and are production by definition.
ALTER TABLE move_out_requests ADD COLUMN environment TEXT NOT NULL DEFAULT 'PRODUCTION';
CREATE INDEX idx_move_out_environment ON move_out_requests (environment, submitted_at DESC);
