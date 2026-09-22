CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS cli_sessions (
  hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  user_id UUID PRIMARY KEY REFERENCES users(id), credential TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY, lender_id UUID NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
  token_limit INTEGER NOT NULL CHECK(token_limit > 0), duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  expires_at TIMESTAMPTZ NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS grants (
  id UUID PRIMARY KEY, offer_id UUID NOT NULL REFERENCES offers(id), borrower_id UUID NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','active','denied','revoked')),
  token_limit INTEGER NOT NULL CHECK(token_limit > 0), used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
  expires_at TIMESTAMPTZ, code_hash TEXT UNIQUE, code_cipher TEXT, redeemed_at TIMESTAMPTZ,
  busy_id UUID, busy_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(offer_id, borrower_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), grant_id UUID NOT NULL REFERENCES grants(id),
  title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY, grant_id UUID NOT NULL REFERENCES grants(id), conversation_id UUID NOT NULL REFERENCES conversations(id),
  tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS grants_borrower ON grants(borrower_id);
ALTER TABLE connections ADD COLUMN IF NOT EXISTS busy_id UUID; ALTER TABLE connections ADD COLUMN IF NOT EXISTS busy_until TIMESTAMPTZ;
