-- Schema cho D1. Chạy:
--   wrangler d1 execute api-worker-db --local --file=./schema.sql
--   wrangler d1 execute api-worker-db --remote --file=./schema.sql

DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  -- UNIQUE ở tầng DB là chốt cuối: hai request song song cùng gửi một email
  -- thì validate trong code không chặn được, ràng buộc này mới chặn.
  email      TEXT    NOT NULL UNIQUE,
  age        INTEGER CHECK (age IS NULL OR (age >= 0 AND age <= 150)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users (email);

INSERT INTO users (name, email, age) VALUES
  ('Nguyễn Văn A', 'a@example.com', 30),
  ('Trần Thị B',   'b@example.com', 25),
  ('Lê Văn C',     'c@example.com', NULL);
