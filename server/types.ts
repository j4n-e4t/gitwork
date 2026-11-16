export const REASONS = ["authored", "review", "assigned", "mentioned", "commented", "watching"] as const;
export type Reason = (typeof REASONS)[number];

export type ItemType = "pr" | "issue" | "discussion";

type ItemBase = {
  owner: string;
  ownerAvatarUrl: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: string | null;
  authorAvatarUrl: string | null;
  // Profile page (an app page for bots). Missing from boards cached before this field existed.
  authorUrl?: string | null;
  comments: number;
  reasons: Reason[];
};

export type PullRequest = ItemBase & {
  type: "pr";
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  // URLs of issues this PR closes (closing keywords or the Development sidebar). Missing from boards cached
  // before this field existed.
  closes?: string[];
};

export type Issue = ItemBase & {
  type: "issue";
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
};

export type Discussion = ItemBase & {
  type: "discussion";
  closed: boolean;
  stateReason: "RESOLVED" | "OUTDATED" | "DUPLICATE" | "REOPENED" | null;
  category: string;
  // null when the category isn't Q&A-style, so "answered" doesn't apply.
  isAnswered: boolean | null;
  locked: boolean;
  upvotes: number;
};

export type WorkItem = PullRequest | Issue | Discussion;

export const isClosed = (item: WorkItem) => (item.type === "discussion" ? item.closed : item.state !== "OPEN");

export const itemKey = (item: { owner: string; repo: string; number: number }) => `${item.owner}/${item.repo}#${item.number}`;

// Board rules shared by the web and mobile clients.

export function isHidden(item: WorkItem, hidden: HiddenItem[]) {
  return hidden.some(
    (h) =>
      (h.kind === "owner" && h.key === item.owner) ||
      (h.kind === "repo" && h.key === `${item.owner}/${item.repo}`) ||
      (h.kind === "pr" && h.key === itemKey(item)) ||
      (h.kind === "author" && item.author !== null && h.key === authorKey(item.author)),
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

// An item appears only in the column of its highest-ranked reason. Its other reasons stay on the item, so the
// star still reflects whether it's watched.
export function inColumn(item: WorkItem, reason: Reason, precedence: Reason[]) {
  return precedence.find((r) => item.reasons.includes(r)) === reason;
}

// A bookmark GitHub could not resolve (deleted or the token lost access). Its type is unknown.
export type MissingBookmark = { owner: string; repo: string; number: number };

// kind "pr" hides a single issue, PR or discussion by "owner/repo#number"; the name predates the other types and
// is kept so existing rows stay valid (all three share one number sequence per repo, so the key is unambiguous).
// kind "author" hides everything opened by a user or bot, keyed by authorKey.
export type HiddenItem = { kind: "owner" | "repo" | "pr" | "author"; key: string };

// How an author rule matches a login: case-insensitive, and "dependabot[bot]" (how GitHub's REST API and web UI
// name bots) is the same author as "dependabot" (how GraphQL, which the board uses, names them).
export const authorKey = (login: string) => login.trim().toLowerCase().replace(/\[bot\]$/, "");

export type WorkView = {
  viewer: string;
  items: WorkItem[];
  missing: MissingBookmark[];
  hidden: HiddenItem[];
  // Saved board column order; null until the user rearranges columns.
  columnOrder: Reason[] | null;
  // Saved precedence: an item shows only in the column of its highest-ranked reason. null until changed.
  precedence: Reason[] | null;
  // "owner/repo#number" of closed or merged items the user checked off; they're hidden until reopened.
  dismissed: string[];
  // True when the GitHub data came from a cache old enough that the client should ask for a fresh copy.
  stale: boolean;
  // Searches with more results than the board fetches; only their most recently updated items are shown.
  truncated: { type: ItemType; reason: Reason }[];
};

export type RateLimit = { limit: number; remaining: number; resetAt: string };

// Full details for the preview dialog, fetched on demand. The card's WorkItem already covers title and state.
// `url` is the profile page (an app page for bots); null for commit authors without a GitHub account.
export type Person = { login: string; avatarUrl: string; url: string | null };

// The latest comments (or replies) and, when there are more, the cursor for loading the ones before them.
export type CommentPage = { total: number; latest: ItemComment[]; before: string | null };

// A PR's conversation interleaves comments and reviews; a review's inline code comments are its replies.
export type ItemComment = {
  // GitHub's node id; a discussion comment's or review's is used to load its earlier replies.
  id: string;
  author: Person | null;
  bodyHTML: string;
  createdAt: string;
  url: string;
  // Discussion comments only: whether it's the accepted answer, its upvotes and the latest replies in its thread.
  isAnswer: boolean;
  upvotes: number | null;
  replies: CommentPage | null;
  // PR reviews only: the verdict.
  review: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | null;
  // Inline review comments only: the file and line, and the diff hunk ending at that line.
  code: { path: string; line: number | null; diffHunk: string } | null;
};

// A page of earlier comments or replies, oldest first, with the references in their bodies resolved.
export type EarlierComments = { comments: ItemComment[]; before: string | null; references: Record<string, ReferencedItem> };

export type CheckStatus = "success" | "failure" | "pending" | "neutral" | "skipped";

// A PR and the issues it closes, linked either way (GitHub's "Development" links). The item may not be on the board.
type LinkedBase = { owner: string; repo: string; number: number; title: string; url: string };
export type LinkedItem =
  | (LinkedBase & Pick<PullRequest, "type" | "state" | "isDraft">)
  | (LinkedBase & Pick<Issue, "type" | "state" | "stateReason">);

// An issue, PR or discussion linked from a body or comment, for coloring the reference by its state and its hover card.
export type ReferencedItem = (LinkedItem | (LinkedBase & Pick<Discussion, "type" | "closed" | "stateReason">)) & {
  author: Person | null;
  createdAt: string;
  // The start of the body as plain text, cut to a preview length.
  excerpt: string;
};

// A user or organization, for the hover card on @mentions. Fetched on demand.
export type ProfileSummary = {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
  // A user's bio or an organization's description.
  bio: string | null;
  location: string | null;
  createdAt: string;
};

// "owner/repo#number" (lowercased) of a GitHub issue, PR or discussion URL, which is how ItemDetails.references
// is keyed. GitHub's `data-url` on reference links always uses /issues/ for PRs.
export function referenceKey(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull|discussions)\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
}

// Typed references ("#123") come out of GitHub's renderer as `<a class="issue-link" data-url=...>`. One written as a
// Markdown link ("[#123](https://github.com/...)") gets neither, only a hovercard type, so links whose text reads
// like a reference ("#123", "owner/repo#123") and that point at an issue, PR or discussion count as references too.
const REFERENCE_TEXT = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/;

/** The kind of item a body link refers to, or null when it's an ordinary link. */
export function referenceLinkKind(link: { className: string; text: string; href: string; hovercardType?: string | null }) {
  const isReference = /(^|\s)issue-link(\s|$)/.test(link.className) || (REFERENCE_TEXT.test(link.text.trim()) && referenceKey(link.href) !== null);
  if (!isReference) return null;
  const type = link.hovercardType ?? (/\/discussions\/\d/.test(link.href) ? "discussion" : /\/pull\/\d/.test(link.href) ? "pull_request" : "issue");
  return type === "issue" || type === "pull_request" || type === "discussion" ? type : null;
}

export type TimelineEvent = {
  kind:
    | "commented"
    | "reviewed"
    | "committed"
    | "force_pushed"
    | "merged"
    | "closed"
    | "reopened"
    | "labeled"
    | "unlabeled"
    | "assigned"
    | "review_requested"
    | "ready_for_review"
    | "converted_to_draft"
    | "renamed"
    | "referenced";
  actor: Person | null;
  createdAt: string;
  // What the event is about, such as a label name, review state, new title or a commit's message headline.
  detail: string | null;
  url: string | null;
  // Fuller details for the History tab, each only on the kinds it applies to.
  label?: { name: string; color: string };
  // Who was assigned or asked to review. A team has only its name, as login.
  subject?: Person;
  previousTitle?: string;
  // The start of a comment's or review's text.
  excerpt?: string;
  commit?: { sha: string; message: string; additions: number; deletions: number; changedFiles: number | null; checks: PullRequest["checks"] };
  // The issue or PR that referenced this one.
  source?: LinkedItem;
  merge?: { sha: string; into: string };
  forcePush?: { before: string | null; after: string | null };
};

export type ItemDetails = {
  author: Person | null;
  createdAt: string;
  // Rendered and sanitized by GitHub.
  bodyHTML: string;
  labels: { name: string; color: string }[];
  assignees: Person[];
  comments: CommentPage;
  // Latest activity, newest first.
  timeline: TimelineEvent[];
  linked: LinkedItem[];
  // Everyone involved: author, participants, assignees, reviewers, commenters and timeline actors, bots included.
  involved: Person[];
  // Issues, PRs and discussions referenced in the body and comments, by referenceKey. Missing ones (no access, or
  // over the limit) are shown without a state.
  references: Record<string, ReferencedItem>;
  pr: {
    baseRef: string;
    headRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    commits: number;
    // The first 100 of changedFiles.
    files: { path: string; additions: number; deletions: number }[];
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    reviews: { author: Person | null; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" }[];
    requestedReviewers: string[];
    checks: { name: string; status: CheckStatus; url: string | null }[];
  } | null;
  discussion: { answer: ItemComment | null } | null;
};

// A PR's commits and diffs, fetched on demand for the preview's Commits and Files changed tabs.
export type Commit = {
  sha: string;
  message: string;
  // Null when the commit's email isn't linked to a GitHub account; authorName is the git author then.
  author: Person | null;
  authorName: string;
  authoredAt: string;
  url: string;
};

export type DiffFile = {
  path: string;
  // The old path of a renamed or copied file.
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  // The unified diff's hunks. GitHub leaves it out for binary files and very large diffs.
  patch: string | null;
};

// `truncated` when GitHub has more than were fetched (commits stop at 250, files at 300).
export type CommitList = { commits: Commit[]; truncated: boolean };
export type Diff = { files: DiffFile[]; truncated: boolean };

// The part of the board that comes from GitHub (and is cached); the rest is read from the database per request.
export type GitHubWorkView = Pick<WorkView, "viewer" | "items" | "missing" | "truncated">;

// An AI-written overview of an item, generated on request from its full context and cached.
export type ItemSummary = {
  tldr: string;
  what: string;
  who: string;
  why: string;
  related: string;
  status: string;
  model: string;
  generatedAt: string;
  // The item's updatedAt when the summary was written; a newer one on the board means it may be out of date.
  itemUpdatedAt: string;
};
