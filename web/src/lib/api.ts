import { itemKey } from "../../../server/types.ts";
import type { CommitList, Diff, EarlierComments, HiddenItem, ItemDetails, ItemSummary, ItemType, ProfileSummary, RateLimit, Reason, WorkItem, WorkView } from "../../../server/types.ts";

export { authorKey, inColumn, isClosed, isHidden, itemKey, reasonApplies, referenceKey, referenceLinkKind, resolveReasonOrder } from "../../../server/types.ts";
export type { CheckStatus, CommentPage, Commit, CommitList, Diff, DiffFile, Discussion, HiddenItem, Issue, EarlierComments, ItemComment, ItemDetails, ItemSummary, ItemType, LinkedItem, Person, MissingBookmark, ProfileSummary, PullRequest, RateLimit, Reason, ReferencedItem, TimelineEvent, WorkItem, WorkView } from "../../../server/types.ts";

// summaryAvailable: whether the server has a Gemini key. Missing from sign-ins cached before it existed.
export type Me = { login: string; avatarUrl: string; summaryAvailable?: boolean };

/** The session is missing, expired or its GitHub token was revoked. */
export class UnauthorizedError extends Error {}

// Dev only: with ?demo in the URL every request is answered from fixtures, so the app runs without signing in. The
// import.meta.env.DEV check drops the fixtures from production builds.
const demo = import.meta.env.DEV && new URLSearchParams(location.search).has("demo") ? import("./demo") : null;

async function request(path: string, init?: RequestInit) {
  const res = demo ? await (await demo).demoResponse(path, init) : await fetch(path, init);
  if (res.status === 401) throw new UnauthorizedError("Signed out");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res;
}

function send(path: string, method: "POST" | "PUT" | "DELETE", body: unknown) {
  return request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export const api = {
  me: async (): Promise<Me> => (await request("/api/me")).json(),
  rateLimit: async (): Promise<RateLimit> => (await request("/api/rate-limit")).json(),
  item: async (item: WorkItem): Promise<ItemDetails> => {
    const params = new URLSearchParams({ type: item.type, owner: item.owner, repo: item.repo, number: String(item.number) });
    return (await request(`/api/item?${params}`)).json();
  },
  // The cached AI summary, or null; `generate` writes a new one (several seconds).
  summary: async (item: WorkItem, generate = false): Promise<ItemSummary | null> => {
    const params = new URLSearchParams({ type: item.type, owner: item.owner, repo: item.repo, number: String(item.number) });
    return (await request(`/api/summary?${params}`, { method: generate ? "POST" : "GET" })).json();
  },
  commits: async (pr: WorkItem): Promise<CommitList> => {
    const params = new URLSearchParams({ owner: pr.owner, repo: pr.repo, number: String(pr.number) });
    return (await request(`/api/commits?${params}`)).json();
  },
  // The whole PR's diff, or one commit's.
  diff: async (pr: WorkItem, sha?: string): Promise<Diff> => {
    const params = new URLSearchParams({ owner: pr.owner, repo: pr.repo, number: String(pr.number), ...(sha && { sha }) });
    return (await request(`/api/diff?${params}`)).json();
  },
  // The page of comments before `before`, or with `replyTo` (a discussion comment's id) the replies before it.
  earlierComments: async (item: WorkItem, before: string, replyTo?: string): Promise<EarlierComments> => {
    const params = new URLSearchParams(
      replyTo ? { replyTo, before } : { type: item.type, owner: item.owner, repo: item.repo, number: String(item.number), before },
    );
    return (await request(`/api/comments?${params}`)).json();
  },
  profile: async (login: string): Promise<ProfileSummary> => (await request(`/api/profile?${new URLSearchParams({ login })}`)).json(),
  logout: () => request("/auth/logout", { method: "POST" }),
  // Without `fresh` the server may answer from its cache (flagged `stale` when old).
  work: async (fresh = false): Promise<WorkView> => (await request(fresh ? "/api/work?fresh=1" : "/api/work")).json(),
  // `ref` is a GitHub URL or "owner/repo#number".
  setWatching: (ref: string, watching: boolean) => send("/api/bookmarks", watching ? "POST" : "DELETE", { url: ref }),
  setHidden: (item: HiddenItem, hidden: boolean) => send("/api/hidden", hidden ? "POST" : "DELETE", item),
  setColumnOrder: (order: Reason[]) => send("/api/column-order", "PUT", { order }),
  setPrecedence: (order: Reason[]) => send("/api/precedence", "PUT", { order }),
  setDismissed: (key: string, dismissed: boolean) => send("/api/dismissed", dismissed ? "POST" : "DELETE", { key }),
};

// GitHub names are case-insensitive, and typed input may not match the canonical casing.
export const sameItem = (a: { owner: string; repo: string; number: number }, b: { owner: string; repo: string; number: number }) =>
  itemKey(a).toLowerCase() === itemKey(b).toLowerCase();

const URL_TYPES: Record<string, ItemType> = { pull: "pr", issues: "issue", discussions: "discussion" };

// Mirrors the server's parsing so a bookmark can be shown before the server answers. The type is unknown for
// "owner/repo#123" (and GitHub may redirect /issues/N to a PR), so it's only a hint for placing the placeholder.
export function parseItemInput(input: string): { owner: string; repo: string; number: number; type: ItemType | null } | null {
  const url = input.trim().match(/^(?:https?:\/\/)?github\.com\/(?!orgs\/)([\w.-]+)\/([\w.-]+)\/(pull|issues|discussions)\/(\d+)/);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[4]), type: URL_TYPES[url[3]!]! };
  const short = input.trim().match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  return short ? { owner: short[1]!, repo: short[2]!, number: Number(short[3]), type: null } : null;
}

// Moves `reason` into `target`'s slot, shifting `target` toward where `reason` came from.
export function moveReason(order: Reason[], reason: Reason, target: Reason): Reason[] {
  const movingDown = order.indexOf(reason) < order.indexOf(target);
  const next = order.filter((r) => r !== reason);
  next.splice(next.indexOf(target) + (movingDown ? 1 : 0), 0, reason);
  return next;
}
