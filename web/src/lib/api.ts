import {
  REASONS,
  type HiddenItem,
  type ItemDetails,
  type ItemType,
  type ProfileSummary,
  type RateLimit,
  type Reason,
  type Todo,
  type WorkItem,
  type WorkView,
} from "../../../server/types.ts";

export { isClosed, referenceKey } from "../../../server/types.ts";
export type { CheckStatus, Discussion, HiddenItem, Issue, ItemComment, ItemDetails, ItemType, LinkedItem, Person, MissingBookmark, ProfileSummary, PullRequest, RateLimit, Reason, ReferencedItem, TimelineEvent, Todo, TodoLink, WorkItem, WorkView } from "../../../server/types.ts";

export type Me = { login: string; avatarUrl: string };

/** The session is missing, expired or its GitHub token was revoked. */
export class UnauthorizedError extends Error {}

async function request(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
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
  saveTodo: (todo: Todo) => send(`/api/todos/${todo.id}`, "PUT", todo),
  deleteTodo: (id: string) => request(`/api/todos/${id}`, { method: "DELETE" }),
};

export const itemKey = (item: { owner: string; repo: string; number: number }) => `${item.owner}/${item.repo}#${item.number}`;

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

export function isHidden(item: WorkItem, hidden: HiddenItem[]) {
  return hidden.some(
    (h) =>
      (h.kind === "owner" && h.key === item.owner) ||
      (h.kind === "repo" && h.key === `${item.owner}/${item.repo}`) ||
      (h.kind === "pr" && h.key === itemKey(item)),
  );
}

// Columns each mode shows. GitHub ignores mentions:@me for discussions, so they have no Mentioned column.
const MODE_REASONS: Record<ItemType, Reason[]> = {
  pr: ["authored", "review", "assigned", "mentioned", "watching"],
  issue: ["authored", "assigned", "mentioned", "commented", "watching"],
  discussion: ["authored", "commented", "watching"],
};
export const reasonApplies = (reason: Reason, type: ItemType) => MODE_REASONS[type].includes(reason);

// Saved order with any unknown columns dropped and new ones appended, so adding a column never breaks a saved layout.
export function resolveReasonOrder(saved: Reason[] | null): Reason[] {
  const known = (saved ?? []).filter((r) => REASONS.includes(r));
  return [...known, ...REASONS.filter((r) => !known.includes(r))];
}

// Moves `reason` into `target`'s slot, shifting `target` toward where `reason` came from.
export function moveReason(order: Reason[], reason: Reason, target: Reason): Reason[] {
  const movingDown = order.indexOf(reason) < order.indexOf(target);
  const next = order.filter((r) => r !== reason);
  next.splice(next.indexOf(target) + (movingDown ? 1 : 0), 0, reason);
  return next;
}
