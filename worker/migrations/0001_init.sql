-- rememberKey D1 schema (version 1).
-- Mirrors the former MySQL schema; INTEGER columns use 0/1 for booleans,
-- timestamps are RFC3339 text (created) or unix seconds (expires).

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  -- NOCASE keeps lookups/uniqueness ASCII case-insensitive, matching the
  -- former MySQL utf8mb4 default collation for the characters we accept.
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sign_key TEXT NOT NULL,
  box_key TEXT NOT NULL,
  bundle TEXT NOT NULL,
  bundle_version INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);

-- Usernames are unique via the inline UNIQUE constraint on accounts.username.
-- The bootstrap registration is the only path that creates an admin (see
-- worker/src/auth.ts), matching the Go server; no one-admin index is enforced.

CREATE TABLE devices (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  pub TEXT NOT NULL,
  proof TEXT NOT NULL,
  created TEXT NOT NULL,
  revoked TEXT,
  PRIMARY KEY (account, id)
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  device TEXT NOT NULL,
  message TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX challenges_account ON challenges (account);

CREATE TABLE families (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  device TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX families_account ON families (account);
CREATE INDEX families_device ON families (account, device);

CREATE TABLE access_tokens (
  hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX access_tokens_family ON access_tokens (family);

CREATE TABLE refresh_tokens (
  hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX refresh_tokens_family ON refresh_tokens (family);

CREATE TABLE invitations (
  hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_by TEXT
);

CREATE TABLE records (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  envelope TEXT,
  signature TEXT NOT NULL,
  operation TEXT NOT NULL,
  base INTEGER NOT NULL,
  PRIMARY KEY (account, id)
);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  record TEXT NOT NULL
);

CREATE INDEX changes_account_seq ON changes (account, seq);

CREATE TABLE operations (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  hash TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (account, id)
);

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created TEXT NOT NULL
);

CREATE INDEX audit_seq ON audit (seq);
