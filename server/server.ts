import {
  addBookmark,
  addDismissed,
  addHidden,
  clearCachedWork,
  getCachedWork,
  getColumnOrder,
  getPrecedence,
  getSummary,
  listBookmarks,
  listDismissed,
  listHidden,
  listTracked,
  removeBookmark,
  removeDismissed,
  removeHidden,
  saveSummary,
  setCachedWork,
  setColumnOrder,
  setPrecedence,
  trackItems,
  untrackItems,
  type ItemRef,
  type Session,
} from "./db.ts";
import { currentSession, endSession, handleAuth } from "./auth.ts";
import { summarize, summaryAvailable } from "./summary.ts";
import { fetchCommits, fetchDiff, fetchEarlierComments, fetchItemContext, fetchItemDetails, fetchItemsByRef, fetchProfile, fetchRateLimit, fetchWorkView, GitHubAuthError } from "./github.ts";
import { authorKey, isClosed, isHidden, itemKey, REASONS, type HiddenItem, type ItemType, type Reason, type GitHubWorkView } from "./types.ts";

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
  author: /^[a-z\d-]+$/,
};

function parseHidden(input: unknown): HiddenItem | null {
  const { kind, key } = (input ?? {}) as { kind?: unknown; key?: unknown };
  if (typeof kind !== "string" || typeof key !== "string" || !(kind in HIDDEN_KEY_PATTERNS)) return null;
  const normalized = kind === "author" ? authorKey(key) : key;
  return HIDDEN_KEY_PATTERNS[kind as HiddenItem["kind"]].test(normalized) ? { kind: kind as HiddenItem["kind"], key: normalized } : null;
}

// Column order and precedence must each contain every reason exactly once.
function parseReasonOrder(input: unknown): Reason[] | null {
  const order = (input as { order?: unknown } | null)?.order;
  if (!Array.isArray(order) || order.length !== REASONS.length) return null;
  return REASONS.every((r) => order.includes(r)) ? (order as Reason[]) : null;
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
    return Response.json({ login: session.login, avatarUrl: session.avatarUrl, summaryAvailable: summaryAvailable() });
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
  // GET returns the cached summary (null if there is none); POST generates a new one, which replaces it.
  if (pathname === "/api/summary" && (req.method === "GET" || req.method === "POST")) {
    const params = new URL(req.url).searchParams;
    const type = params.get("type") as ItemType | null;
    const ref = parseItemRef(`${params.get("owner")}/${params.get("repo")}#${params.get("number")}`);
    if (!ref || !type || !["pr", "issue", "discussion"].includes(type)) {
      return Response.json({ error: "Expected type (pr|issue|discussion), owner, repo and number" }, { status: 400 });
    }
    if (req.method === "GET") return Response.json(getSummary(ref));
    let context;
    try {
      context = await fetchItemContext(session.token, type, ref);
    } catch (error) {
      return githubFailure(error, session);
    }
    if (!context) return Response.json({ error: "Not found or no access" }, { status: 404 });
    try {
      const summary = await summarize(context.text, context.updatedAt);
      saveSummary(ref, summary);
      return Response.json(summary);
    } catch (error) {
      console.error(error);
      return Response.json({ error: `Summary failed: ${(error as Error).message}` }, { status: 502 });
    }
  }
  // Earlier comments on an item (?type, owner, repo, number), or earlier replies in a discussion thread (?replyTo=
  // the comment's id), before the ?before cursor from the previous page.
  if (pathname === "/api/comments" && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const before = params.get("before");
    const replyTo = params.get("replyTo");
    const type = params.get("type") as ItemType | null;
    const ref = parseItemRef(`${params.get("owner")}/${params.get("repo")}#${params.get("number")}`);
    // Cursors and node ids are opaque base64-ish strings.
    const opaque = /^[\w+/=:-]{1,200}$/;
    const target = replyTo ? (opaque.test(replyTo) ? { replyTo } : null) : ref && type && ["pr", "issue", "discussion"].includes(type) ? { type, ref } : null;
    if (!target || !before || !opaque.test(before)) {
      return Response.json({ error: "Expected before, and either replyTo or type (pr|issue|discussion), owner, repo and number" }, { status: 400 });
    }
    try {
      const page = await fetchEarlierComments(session.token, target, before);
      return page ? Response.json(page) : Response.json({ error: "Not found or no access" }, { status: 404 });
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  // A PR's commits, and the diff of the whole PR or of one of its commits (?sha=).
  if ((pathname === "/api/commits" || pathname === "/api/diff") && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const ref = parseItemRef(`${params.get("owner")}/${params.get("repo")}#${params.get("number")}`);
    const sha = params.get("sha");
    if (!ref || (sha !== null && !/^[0-9a-f]{7,40}$/i.test(sha))) {
      return Response.json({ error: "Expected owner, repo, number and an optional commit sha" }, { status: 400 });
    }
    try {
      return Response.json(pathname === "/api/commits" ? await fetchCommits(session.token, ref) : await fetchDiff(session.token, ref, sha));
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  if (pathname === "/api/profile" && req.method === "GET") {
    const login = new URL(req.url).searchParams.get("login");
    if (!login || !/^[\w-]+(\[bot\])?$/.test(login)) return Response.json({ error: "Expected a login" }, { status: 400 });
    try {
      const profile = await fetchProfile(session.token, login);
      return profile ? Response.json(profile) : Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return githubFailure(error, session);
    }
  }
  if (pathname === "/api/work" && req.method === "GET") {
    try {
      // ?fresh=1 waits for GitHub; otherwise any cached board is returned immediately.
      const params = new URL(req.url).searchParams;
      const cached = params.has("fresh") ? null : getCachedWork<GitHubWork>(session.login);
      const work = cached?.data ?? (await fetchAndCache(session));
      const stale = cached !== null && Date.now() - cached.fetchedAt > CACHE_FRESH_MS;
      const hidden = listHidden();
      const dismissed = listDismissed();
      // ?visible=1 leaves out hidden and checked-off items, for clients without the web board's "show" toggles (the
      // mobile app), so its filtering follows the server's rules without a rebuild.
      const items = params.has("visible")
        ? work.items.filter((item) => !isHidden(item, hidden) && !(isClosed(item) && dismissed.includes(itemKey(item))))
        : work.items;
      return Response.json({ ...work, items, hidden, columnOrder: getColumnOrder(), precedence: getPrecedence(), dismissed, stale });
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
