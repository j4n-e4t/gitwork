import type { HiddenItem, ItemSummary, ItemType, Reason, WorkItem } from "./types.ts";

export type ItemRef = { owner: string; repo: string; number: number };

let storage: DurableObjectStorage;

const rows = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) =>
  storage.sql.exec<T>(query, ...bindings).toArray();
const run = (query: string, ...bindings: SqlStorageValue[]) => void storage.sql.exec(query, ...bindings);

/** Opens the app's storage and creates missing tables. Called once from the Durable Object's constructor. */
export function initDb(durableStorage: DurableObjectStorage) {
  storage = durableStorage;
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner, repo, number)
    );
    -- key is "owner", "owner/repo" or "owner/repo#number" depending on kind.
    CREATE TABLE IF NOT EXISTS hidden (
      kind TEXT NOT NULL CHECK (kind IN ('owner', 'repo', 'pr', 'author')),
      key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, key)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- GitHub access tokens live here, server-side only; the browser just holds the random session id.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      login TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- Last GitHub result per user, so the board renders instantly while a fresh fetch (several seconds) runs.
    CREATE TABLE IF NOT EXISTS work_cache (
      login TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    -- Closed or merged items the user checked off, by "owner/repo#number".
    CREATE TABLE IF NOT EXISTS dismissed (
      key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Open items that involve a user, remembered so that once they close or merge (and drop out of GitHub's
    -- is:open searches) they can stay on the board, in the same columns, until checked off.
    CREATE TABLE IF NOT EXISTS tracked (
      login TEXT NOT NULL,
      key TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      PRIMARY KEY (login, key)
    );
    -- The latest AI summary per item, by lowercased "owner/repo#number"; data is an ItemSummary as JSON.
    CREATE TABLE IF NOT EXISTS summaries (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
  // Databases from before author rules have a CHECK without 'author'. SQLite can't change a CHECK, so the table is
  // rebuilt with its rows.
  const hiddenSql = rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hidden'")[0]?.sql;
  if (hiddenSql && !hiddenSql.includes("'author'")) {
    storage.transactionSync(() => {
      storage.sql.exec(`
        CREATE TABLE hidden_new (
          kind TEXT NOT NULL CHECK (kind IN ('owner', 'repo', 'pr', 'author')),
          key TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (kind, key)
        );
        INSERT INTO hidden_new (kind, key, created_at) SELECT kind, key, created_at FROM hidden;
        DROP TABLE hidden;
        ALTER TABLE hidden_new RENAME TO hidden;
      `);
    });
  }
}

function getSetting(key: string): Reason[] | null {
  const row = rows<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)[0];
  return row ? JSON.parse(row.value) : null;
}

function setSetting(key: string, order: Reason[]) {
  run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, JSON.stringify(order));
}

export const getColumnOrder = () => getSetting("column_order");
export const getPrecedence = () => getSetting("precedence");
export const setColumnOrder = (order: Reason[]) => setSetting("column_order", order);
export const setPrecedence = (order: Reason[]) => setSetting("precedence", order);

export function listBookmarks(): ItemRef[] {
  return rows<ItemRef>("SELECT owner, repo, number FROM bookmarks ORDER BY created_at DESC");
}

export function addBookmark(ref: ItemRef) {
  run("INSERT OR IGNORE INTO bookmarks (owner, repo, number) VALUES (?, ?, ?)", ref.owner, ref.repo, ref.number);
}

// GitHub names are case-insensitive, and bookmarks keep whatever casing was typed when they were added.
export function removeBookmark(ref: ItemRef) {
  run(
    "DELETE FROM bookmarks WHERE lower(owner) = lower(?) AND lower(repo) = lower(?) AND number = ?",
    ref.owner,
    ref.repo,
    ref.number,
  );
}

export function listHidden(): HiddenItem[] {
  return rows<HiddenItem>("SELECT kind, key FROM hidden ORDER BY kind, key");
}

export function addHidden(item: HiddenItem) {
  run("INSERT OR IGNORE INTO hidden (kind, key) VALUES (?, ?)", item.kind, item.key);
}

export function removeHidden(item: HiddenItem) {
  run("DELETE FROM hidden WHERE kind = ? AND key = ?", item.kind, item.key);
}

export type Session = { id: string; token: string; login: string; avatarUrl: string };

export function createSession(session: Session, ttlMs: number) {
  run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
  run(
    "INSERT INTO sessions (id, token, login, avatar_url, expires_at) VALUES (?, ?, ?, ?, ?)",
    session.id,
    session.token,
    session.login,
    session.avatarUrl,
    Date.now() + ttlMs,
  );
}

export function getSession(id: string): Session | null {
  return (
    rows<Session>(
      "SELECT id, token, login, avatar_url AS avatarUrl FROM sessions WHERE id = ? AND expires_at > ?",
      id,
      Date.now(),
    )[0] ?? null
  );
}

export function deleteSession(id: string) {
  run("DELETE FROM sessions WHERE id = ?", id);
}

export function getCachedWork<T>(login: string): { data: T; fetchedAt: number } | null {
  const row = rows<{ data: string; fetchedAt: number }>(
    "SELECT data, fetched_at AS fetchedAt FROM work_cache WHERE login = ?",
    login,
  )[0];
  return row ? { data: JSON.parse(row.data), fetchedAt: row.fetchedAt } : null;
}

export function setCachedWork(login: string, data: unknown) {
  run("INSERT OR REPLACE INTO work_cache (login, data, fetched_at) VALUES (?, ?, ?)", login, JSON.stringify(data), Date.now());
}

// Bookmarks are shared by all users, so a change invalidates everyone's cached board.
export function clearCachedWork() {
  run("DELETE FROM work_cache");
}

export function listDismissed(): string[] {
  return rows<{ key: string }>("SELECT key FROM dismissed").map((row) => row.key);
}

export function addDismissed(key: string) {
  run("INSERT OR IGNORE INTO dismissed (key) VALUES (?)", key);
}

export function removeDismissed(key: string) {
  run("DELETE FROM dismissed WHERE key = ?", key);
}

export type TrackedItem = ItemRef & { key: string; reasons: Reason[] };

export function listTracked(login: string): TrackedItem[] {
  return rows<ItemRef & { key: string; reasons: string }>(
    "SELECT key, owner, repo, number, reasons FROM tracked WHERE login = ?",
    login,
  ).map((row) => ({ ...row, reasons: JSON.parse(row.reasons) }));
}

export function trackItems(login: string, items: WorkItem[]) {
  storage.transactionSync(() => {
    for (const item of items) {
      run(
        "INSERT OR REPLACE INTO tracked (login, key, owner, repo, number, reasons) VALUES (?, ?, ?, ?, ?, ?)",
        login,
        `${item.owner}/${item.repo}#${item.number}`,
        item.owner,
        item.repo,
        item.number,
        JSON.stringify(item.reasons),
      );
    }
  });
}

export function untrackItems(login: string, keys: string[]) {
  storage.transactionSync(() => {
    for (const key of keys) run("DELETE FROM tracked WHERE login = ? AND key = ?", login, key);
  });
}

const summaryKey = (ref: ItemRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

export function getSummary(ref: ItemRef): ItemSummary | null {
  const row = rows<{ data: string }>("SELECT data FROM summaries WHERE key = ?", summaryKey(ref))[0];
  return row ? JSON.parse(row.data) : null;
}

export function saveSummary(ref: ItemRef, summary: ItemSummary) {
  run("INSERT OR REPLACE INTO summaries (key, data) VALUES (?, ?)", summaryKey(ref), JSON.stringify(summary));
}
