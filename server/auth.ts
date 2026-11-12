import { env } from "cloudflare:workers";
import { createSession, deleteSession, getSession, type Session } from "./db.ts";

// Read on first use rather than at import: secrets aren't available while `wrangler deploy` validates the Worker.
let cached: { clientId: string; clientSecret: string; allowedUsers: Set<string>; appUrl: string | undefined } | undefined;

function config() {
  if (cached) return cached;
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required (GitHub OAuth app)");

  // Bookmarks, hidden items and column order are shared single-user data, so only listed accounts may sign in.
  const allowedUsers = new Set(
    (env.ALLOWED_USERS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedUsers.size === 0) throw new Error("ALLOWED_USERS is required: comma-separated GitHub logins allowed to sign in");

  // Public origin for the OAuth callback. Set it when behind a reverse proxy; otherwise the request's own origin is used.
  cached = { clientId, clientSecret, allowedUsers, appUrl: env.APP_URL?.replace(/\/$/, "") };
  return cached;
}

// `repo` is needed to read private repositories' PRs, issues and discussions.
// read:discussion is needed for discussion categories, which GitHub doesn't cover with repo.
const SCOPES = "repo read:discussion";
const SESSION_COOKIE = "wv_session";
const STATE_COOKIE = "wv_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function origin(req: Request) {
  return config().appUrl ?? new URL(req.url).origin;
}

function cookie(name: string, value: string, req: Request, maxAgeSeconds: number) {
  const secure = origin(req).startsWith("https:") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function readCookie(req: Request, name: string) {
  const match = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export function currentSession(req: Request): Session | null {
  const id = readCookie(req, SESSION_COOKIE);
  return id ? getSession(id) : null;
}

/** Forgets the session, e.g. after GitHub rejects its token. */
export function endSession(session: Session) {
  deleteSession(session.id);
}

function startLogin(req: Request) {
  const { clientId } = config();
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin(req)}/auth/callback`,
    scope: SCOPES,
    state,
  });
  return redirect(`https://github.com/login/oauth/authorize?${params}`, [cookie(STATE_COOKIE, state, req, 600)]);
}

function failure(message: string, status: number) {
  return new Response(`${message}\n\nGo back and try signing in again.`, { status, headers: { "Content-Type": "text/plain" } });
}

async function finishLogin(req: Request) {
  const { clientId, clientSecret, allowedUsers } = config();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== readCookie(req, STATE_COOKIE)) return failure("Sign-in failed: invalid or expired state.", 400);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitwork" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${origin(req)}/auth/callback` }),
  });
  const tokenBody = (await tokenRes.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
  const token = tokenBody?.access_token;
  if (!token) return failure(`Sign-in failed: ${tokenBody?.error_description ?? `GitHub returned ${tokenRes.status}`}`, 502);

  const userRes = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "gitwork" } });
  if (!userRes.ok) return failure(`Sign-in failed: couldn't load your GitHub profile (${userRes.status}).`, 502);
  const user = (await userRes.json()) as { login: string; avatar_url: string };
  if (!allowedUsers.has(user.login.toLowerCase())) {
    return failure(`GitHub user ${user.login} isn't allowed to use this instance (see ALLOWED_USERS).`, 403);
  }

  const id = crypto.randomUUID();
  createSession({ id, token, login: user.login, avatarUrl: user.avatar_url }, SESSION_TTL_MS);
  return redirect("/", [cookie(SESSION_COOKIE, id, req, SESSION_TTL_MS / 1000), cookie(STATE_COOKIE, "", req, 0)]);
}

function logout(req: Request) {
  const session = currentSession(req);
  if (session) deleteSession(session.id);
  return redirect("/", [cookie(SESSION_COOKIE, "", req, 0)]);
}

/** Handles /auth/* routes; returns null for anything else. */
export function handleAuth(req: Request, pathname: string): Response | Promise<Response> | null {
  if (pathname === "/auth/login" && req.method === "GET") return startLogin(req);
  if (pathname === "/auth/callback" && req.method === "GET") return finishLogin(req);
  // POST so a link or image on another site can't sign you out.
  if (pathname === "/auth/logout" && req.method === "POST") return logout(req);
  return null;
}
