import {
  addBookmark,
  addDismissed,
  addHidden,
  clearCachedWork,
  deleteTodo,
  getCachedWork,
  getColumnOrder,
  getPrecedence,
  listBookmarks,
  listDismissed,
  listHidden,
  listTracked,
  listTodos,
  removeBookmark,
  removeDismissed,
  removeHidden,
  saveTodo,
  setCachedWork,
  setColumnOrder,
  setPrecedence,
  trackItems,
  untrackItems,
  type ItemRef,
  type Session,
} from "./db.ts";
import { currentSession, endSession, handleAuth } from "./auth.ts";
import { fetchItemDetails, fetchItemsByRef, fetchRateLimit, fetchWorkView, GitHubAuthError } from "./github.ts";
import { isClosed, REASONS, type HiddenItem, type ItemType, type Reason, type Todo, type GitHubWorkView } from "./types.ts";

// Accepts "https://github.com/owner/repo/pull/123", ".../issues/123", ".../discussions/123" or "owner/repo#123".
function parseItemRef(input: unknown): ItemRef | null {
  if (typeof input !== "string") return null;
  const match =
    input.trim().match(/^(?:https?:\/\/)?github\.com\/(?!orgs\/)([\w.-]+)\/([\w.-]+)\/(?:pull|issues|discussions)\/(\d+)/) ??
    input.trim().match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null;
}

const HIDDEN_KEY_PATTERNS: Record<HiddenItem["kind"], RegExp> = {
  owner: /^[\w.-]+$/,
  repo: /^[\w.-]+\/[\w.-]+$/,
  pr: /^[\w.-]+\/[\w.-]+#\d+$/,
};

function parseHidden(input: unknown): HiddenItem | null {
  const { kind, key } = (input ?? {}) as { kind?: unknown; key?: unknown };
  if (typeof kind !== "string" || typeof key !== "string" || !(kind in HIDDEN_KEY_PATTERNS)) return null;
  return HIDDEN_KEY_PATTERNS[kind as HiddenItem["kind"]].test(key) ? { kind: kind as HiddenItem["kind"], key } : null;
}

// Column order and precedence must each contain every reason exactly once.
function parseReasonOrder(input: unknown): Reason[] | null {
  const order = (input as { order?: unknown } | null)?.order;
  if (!Array.isArray(order) || order.length !== REASONS.length) return null;
  return REASONS.every((r) => order.includes(r)) ? (order as Reason[]) : null;
}

const ITEM_TYPES: ItemType[] = ["pr", "issue", "discussion"];
const TODO_ID = /^[\w-]{1,64}$/;

function parseTodo(input: unknown, id: string): Omit<Todo, "createdAt"> | null {
  const { title, deadline, done, link } = (input ?? {}) as Record<string, unknown>;
  if (!TODO_ID.test(id) || typeof title !== "string" || !title.trim() || title.length > 500) return null;
  if (deadline !== null && (typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(deadline))) return null;
  if (typeof done !== "boolean") return null;
  if (link === null) return { id, title: title.trim(), deadline, done, link: null };
  const l = (link ?? {}) as Record<string, unknown>;
  const ref = parseItemRef(`${l.owner}/${l.repo}#${l.number}`);
  if (!ref || !ITEM_TYPES.includes(l.type as ItemType) || typeof l.title !== "string") return null;
  return { id, title: title.trim(), deadline, done, link: { ...ref, type: l.type as ItemType, title: l.title } };
}

// A rejected or under-scoped token ends the session so the client falls back to the sign-in screen; other failures are upstream errors.
function githubFailure(error: unknown, session: Session) {
  if (error instanceof GitHubAuthError) {
    endSession(session);
    return Response.json({ error: `${(error as Error).message}; sign in again` }, { status: 401 });
  }
  console.error(error);
  return Response.json({ error: (error as Error).message }, { status: 502 });
}

type GitHubWork = GitHubWorkView;

// Cached boards younger than this are served as-is; older ones are served but flagged stale.
const CACHE_FRESH_MS = 60_000;
// One GitHub fetch per user at a time; concurrent requests share it.
const inFlight = new Map<string, Promise<GitHubWork>>();
// Bumped when bookmarks change, so a fetch that started before the change doesn't cache an outdated board.
let cacheGeneration = 0;

const keyOf = (item: ItemRef) => `${item.owner}/${item.repo}#${item.number}`;
// Upper bound on extra lookups per refresh; any beyond it are checked on a later refresh.
const MAX_CLOSED_LOOKUPS = 50;

// GitHub's searches only return open PRs and issues, so an item that merges or closes would vanish from the
// board. Items that involved the user while open are remembered; when one drops out of the searches it's looked
// up directly and, if closed, stays in its old columns until the user checks it off. One that's still open no
// longer involves the user (e.g. their review was done), so it's forgotten.
async function keepClosedItems(session: Session, work: GitHubWork) {
  const dismissed = new Set(listDismissed());
  // A reopened item comes back; checking it off again is a new decision.
  for (const item of work.items) if (!isClosed(item) && dismissed.delete(keyOf(item))) removeDismissed(keyOf(item));

  const present = new Set(work.items.map(keyOf));
  const tracked = listTracked(session.login);
  const gone = tracked.filter((t) => !present.has(t.key) && !dismissed.has(t.key)).slice(0, MAX_CLOSED_LOOKUPS);
  const found = await fetchItemsByRef(session.token, gone);
  const forget = tracked.filter((t) => dismissed.has(t.key)).map((t) => t.key);
  gone.forEach((t, i) => {
    const item = found[i];
    if (item && isClosed(item)) work.items.push({ ...item, reasons: t.reasons });
    else forget.push(t.key);
  });
  untrackItems(session.login, forget);

  // Bookmarks already persist, so only involvement from searches needs remembering.
  const involving = work.items
    .filter((item) => !isClosed(item) && item.reasons.some((r) => r !== "watching"))
    .map((item) => ({ ...item, reasons: item.reasons.filter((r) => r !== "watching") }));
  trackItems(session.login, involving);
  work.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function fetchAndCache(session: Session) {
  const running = inFlight.get(session.login);
  if (running) return running;
  const generation = cacheGeneration;
  const fetch = fetchWorkView(session.token, listBookmarks())
    .then(async (work) => {
      // Watching is for items that don't otherwise involve you: once one does (authored, mentioned, ...), its
      // bookmark is dropped, so it stays on the board only for as long as that involvement lasts.
      for (const item of work.items) {
        if (item.reasons.includes("watching") && item.reasons.length > 1) {
          removeBookmark(item);
          item.reasons = item.reasons.filter((r) => r !== "watching");
        }
      }
      await keepClosedItems(session, work);
      if (generation === cacheGeneration) setCachedWork(session.login, work);
      return work;
    })
    .finally(() => {
      if (inFlight.get(session.login) === fetch) inFlight.delete(session.login);
    });
  inFlight.set(session.login, fetch);
  return fetch;
}

function invalidateWork() {
  cacheGeneration++;
  inFlight.clear();
  clearCachedWork();
}

/** Handles /auth/* and /api/* requests; runs inside the Durable Object, which owns the storage and the module state above. */
export async function handleRequest(req: Request) {
  const { pathname } = new URL(req.url);

  const authResponse = handleAuth(req, pathname);
  if (authResponse) return authResponse;
  // The frontend itself is public so it can show the sign-in screen; all data sits behind /api.
  if (!pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

  const session = currentSession(req);
  if (!session) return Response.json({ error: "Not signed in" }, { status: 401 });

  if (pathname === "/api/me" && req.method === "GET") {
    return Response.json({ login: session.login, avatarUrl: session.avatarUrl });
  }
  if (pathname === "/api/rate-limit" && req.method === "GET") {
    try {
      return Response.json(await fetchRateLimit(session.token));
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  if (pathname === "/api/item" && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const type = params.get("type") as ItemType | null;
    const ref = parseItemRef(`${params.get("owner")}/${params.get("repo")}#${params.get("number")}`);
    if (!ref || !type || !["pr", "issue", "discussion"].includes(type)) {
      return Response.json({ error: "Expected type (pr|issue|discussion), owner, repo and number" }, { status: 400 });
    }
    try {
      const details = await fetchItemDetails(session.token, type, ref);
      return details ? Response.json(details) : Response.json({ error: "Not found or no access" }, { status: 404 });
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  if (pathname === "/api/work" && req.method === "GET") {
    try {
      // ?fresh=1 waits for GitHub; otherwise any cached board is returned immediately.
      const cached = new URL(req.url).searchParams.has("fresh") ? null : getCachedWork<GitHubWork>(session.login);
      const work = cached?.data ?? (await fetchAndCache(session));
      const stale = cached !== null && Date.now() - cached.fetchedAt > CACHE_FRESH_MS;
      return Response.json({ ...work, hidden: listHidden(), columnOrder: getColumnOrder(), precedence: getPrecedence(), todos: listTodos(), dismissed: listDismissed(), stale });
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  if (pathname === "/api/bookmarks" && (req.method === "POST" || req.method === "DELETE")) {
    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const ref = parseItemRef(body?.url);
    // Org discussion URLs don't name the repo the discussion lives in, which the bookmark needs.
    if (!ref && typeof body?.url === "string" && /github\.com\/orgs\/[^/]+\/discussions\//.test(body.url)) {
      return Response.json(
        { error: "Organization discussion URLs can't be bookmarked directly; use owner/repo#number for the repo it lives in" },
        { status: 400 },
      );
    }
    if (!ref) return Response.json({ error: "Expected a GitHub PR, issue or discussion URL, or owner/repo#number" }, { status: 400 });
    if (req.method === "POST") addBookmark(ref);
    else removeBookmark(ref);
    invalidateWork();
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/dismissed" && (req.method === "POST" || req.method === "DELETE")) {
    const ref = parseItemRef(((await req.json().catch(() => null)) as { key?: unknown } | null)?.key);
    if (!ref) return Response.json({ error: "Expected { key: owner/repo#number }" }, { status: 400 });
    if (req.method === "POST") addDismissed(keyOf(ref));
    else removeDismissed(keyOf(ref));
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/hidden" && (req.method === "POST" || req.method === "DELETE")) {
    const item = parseHidden(await req.json().catch(() => null));
    if (!item) return Response.json({ error: "Expected { kind: owner|repo|pr, key }" }, { status: 400 });
    if (req.method === "POST") addHidden(item);
    else removeHidden(item);
    return new Response(null, { status: 204 });
  }
  const todoId = pathname.match(/^\/api\/todos\/([^/]+)$/)?.[1];
  if (todoId && req.method === "PUT") {
    const todo = parseTodo(await req.json().catch(() => null), todoId);
    if (!todo) return Response.json({ error: "Expected { title, deadline: YYYY-MM-DD | null, done, link: { type, owner, repo, number, title } | null }" }, { status: 400 });
    saveTodo(todo);
    return new Response(null, { status: 204 });
  }
  if (todoId && req.method === "DELETE") {
    deleteTodo(todoId);
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/precedence" && req.method === "PUT") {
    const order = parseReasonOrder(await req.json().catch(() => null));
    if (!order) return Response.json({ error: `Expected { order } containing each of ${REASONS.join(", ")} once` }, { status: 400 });
    setPrecedence(order);
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/column-order" && req.method === "PUT") {
    const order = parseReasonOrder(await req.json().catch(() => null));
    if (!order) return Response.json({ error: `Expected { order } containing each of ${REASONS.join(", ")} once` }, { status: 400 });
    setColumnOrder(order);
    return new Response(null, { status: 204 });
  }
  return new Response("Not found", { status: 404 });
}
