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
  // The mobile app has no cookie jar shared with the sign-in page, so it sends the session id as a bearer token.
  const bearer = req.headers.get("authorization")?.match(/^Bearer ([\w-]+)$/)?.[1];
  const id = bearer ?? readCookie(req, SESSION_COOKIE);
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
  const { clientId, clientSecret } = config();
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

  const session = await startSession(token);
  if ("error" in session) return failure(session.error, session.status);
  return redirect("/", [cookie(SESSION_COOKIE, session.id, req, SESSION_TTL_MS / 1000), cookie(STATE_COOKIE, "", req, 0)]);
}

// Creates a session for a fresh GitHub token if its user is allowed in.
async function startSession(token: string): Promise<{ id: string } | { error: string; status: number }> {
  const userRes = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "gitwork" } });
  if (!userRes.ok) return { error: `Sign-in failed: couldn't load your GitHub profile (${userRes.status}).`, status: 502 };
  const user = (await userRes.json()) as { login: string; avatar_url: string };
  if (!config().allowedUsers.has(user.login.toLowerCase())) {
    return { error: `GitHub user ${user.login} isn't allowed to use this instance (see ALLOWED_USERS).`, status: 403 };
  }
  const id = crypto.randomUUID();
  createSession({ id, token, login: user.login, avatarUrl: user.avatar_url }, SESSION_TTL_MS);
  return { id };
}

// GitHub's device flow, used by the mobile app: it shows the user a code to enter at github.com/login/device, then
// polls until GitHub hands out a token. No callback URL is involved, so it works from any address the phone uses.
// Requires "Enable Device Flow" in the OAuth app's settings.
async function startDeviceLogin() {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitwork" },
    body: JSON.stringify({ client_id: config().clientId, scope: SCOPES }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body?.device_code) {
    const reason = body?.error === "device_flow_disabled" ? "enable Device Flow in the GitHub OAuth app settings" : `GitHub returned ${res.status}`;
    return Response.json({ error: `Sign-in failed: ${reason}` }, { status: 502 });
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  return Response.json({ deviceCode: device_code, userCode: user_code, verificationUri: verification_uri, expiresIn: expires_in, interval });
}

// Answers 202 while the user hasn't entered the code yet, and the session id once they have.
async function pollDeviceLogin(req: Request) {
  const { deviceCode } = ((await req.json().catch(() => null)) ?? {}) as { deviceCode?: unknown };
  if (typeof deviceCode !== "string") return Response.json({ error: "deviceCode is required" }, { status: 400 });
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gitwork" },
    body: JSON.stringify({ client_id: config().clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string; interval?: number } | null;
  if (body?.error === "authorization_pending" || body?.error === "slow_down") {
    return Response.json({ pending: true, interval: body.interval ?? null }, { status: 202 });
  }
  if (!body?.access_token) {
    return Response.json({ error: `Sign-in failed: ${body?.error_description ?? `GitHub returned ${res.status}`}` }, { status: 400 });
  }
  const session = await startSession(body.access_token);
  if ("error" in session) return Response.json({ error: session.error }, { status: session.status });
  return Response.json({ session: session.id });
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
  if (pathname === "/auth/device" && req.method === "POST") return startDeviceLogin();
  if (pathname === "/auth/device/token" && req.method === "POST") return pollDeviceLogin(req);
  // POST so a link or image on another site can't sign you out.
  if (pathname === "/auth/logout" && req.method === "POST") return logout(req);
  return null;
}
