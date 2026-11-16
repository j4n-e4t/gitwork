import type { ItemRef } from "./db.ts";
import type {
  CheckStatus,
  CommentPage,
  Commit,
  CommitList,
  Diff,
  DiffFile,
  Discussion,
  EarlierComments,
  GitHubWorkView,
  Issue,
  ItemComment,
  ItemDetails,
  ItemType,
  LinkedItem,
  Person,
  ProfileSummary,
  PullRequest,
  RateLimit,
  Reason,
  ReferencedItem,
  TimelineEvent,
  WorkItem,
} from "./types.ts";
import { referenceKey, referenceLinkKind } from "./types.ts";

/** GitHub rejected the token (revoked, app access removed, or granted before the app needed more scopes); the user must sign in again. */
export class GitHubAuthError extends Error {}

const COMMON_FIELDS = `
  number title url updatedAt
  repository { name owner { login avatarUrl(size: 64) } }
  author { login avatarUrl(size: 40) url }
  comments { totalCount }
`;
const ITEM_FIELDS = `
  ... on PullRequest {
    __typename ${COMMON_FIELDS} state isDraft reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    closingIssuesReferences(first: 10) { nodes { url } }
  }
  ... on Issue { __typename ${COMMON_FIELDS} state stateReason }
`;
const DISCUSSION_FIELDS = `
  ... on Discussion {
    __typename ${COMMON_FIELDS}
    closed stateReason isAnswered locked upvoteCount
    category { name isAnswerable }
  }
`;

type SearchReason = Exclude<Reason, "watching">;
const SEARCHES: { alias: string; type: ItemType; reason: SearchReason; filter: string }[] = [
  { alias: "pr_authored", type: "pr", reason: "authored", filter: "author:@me" },
  { alias: "pr_review", type: "pr", reason: "review", filter: "review-requested:@me" },
  { alias: "pr_assigned", type: "pr", reason: "assigned", filter: "assignee:@me" },
  { alias: "pr_mentioned", type: "pr", reason: "mentioned", filter: "mentions:@me" },
  { alias: "issue_authored", type: "issue", reason: "authored", filter: "author:@me" },
  { alias: "issue_assigned", type: "issue", reason: "assigned", filter: "assignee:@me" },
  { alias: "issue_mentioned", type: "issue", reason: "mentioned", filter: "mentions:@me" },
  { alias: "issue_commented", type: "issue", reason: "commented", filter: "commenter:@me" },
  // Discussions include closed threads so their outcome stays visible. GitHub ignores mentions:@me for
  // discussions (it returns unrelated threads), so there's no Mentioned search here.
  { alias: "discussion_authored", type: "discussion", reason: "authored", filter: "author:@me" },
  { alias: "discussion_commented", type: "discussion", reason: "commented", filter: "commenter:@me" },
];

type Search = (typeof SEARCHES)[number];
// Each search is fetched 50 at a time, most recently updated first. Past this many pages the rest are left out
// and the search is reported as truncated.
const MAX_SEARCH_PAGES = 4;

// With `paged`, the search continues from the cursor in the query variable named after its alias.
function searchField({ alias, type, filter }: Search, paged = false) {
  const query =
    type === "discussion"
      ? `${filter} sort:updated-desc` // archived:false silently matches nothing for discussions
      : `is:${type} is:open archived:false ${filter} sort:updated-desc`;
  const searchType = type === "discussion" ? "DISCUSSION" : "ISSUE";
  const fields = type === "discussion" ? DISCUSSION_FIELDS : ITEM_FIELDS;
  const after = paged ? `, after: $${alias}` : "";
  return `${alias}: search(query: "${query}", type: ${searchType}, first: 50${after}) {
    pageInfo { hasNextPage endCursor } nodes { ${fields} }
  }`;
}

type SearchPage = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawItem[] };

type RawCommon = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  repository: { name: string; owner: { login: string; avatarUrl: string } };
  author: { login: string; avatarUrl: string; url: string } | null;
  comments: { totalCount: number };
};
type RawItem =
  | (RawCommon & {
      __typename: "PullRequest";
      state: PullRequest["state"];
      isDraft: boolean;
      reviewDecision: PullRequest["reviewDecision"];
      commits: { nodes: { commit: { statusCheckRollup: { state: PullRequest["checks"] } | null } }[] };
      closingIssuesReferences: { nodes: { url: string }[] };
    })
  | (RawCommon & { __typename: "Issue"; state: Issue["state"]; stateReason: Issue["stateReason"] })
  | (RawCommon & {
      __typename: "Discussion";
      closed: boolean;
      stateReason: Discussion["stateReason"];
      isAnswered: boolean | null;
      locked: boolean;
      upvoteCount: number;
      category: { name: string; isAnswerable: boolean };
    });

// GitHub rejects requests without a User-Agent, which Workers fetch does not send by default.
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "User-Agent": "gitwork" });

async function graphql(token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new GitHubAuthError("GitHub rejected the session token");
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Record<string, any>; errors?: { type?: string; message: string }[] };
  // Tokens from before a scope was added; signing in again grants it.
  if (body.errors?.some((e) => e.type === "INSUFFICIENT_SCOPES")) throw new GitHubAuthError("GitHub token is missing a required scope");
  // Unresolvable bookmarks come back as NOT_FOUND errors next to partial data; anything else is fatal.
  const fatal = body.errors?.filter((e) => e.type !== "NOT_FOUND");
  if (!body.data || fatal?.length) throw new Error(`GitHub API: ${(fatal ?? body.errors)?.map((e) => e.message).join("; ")}`);
  return body.data;
}

function toItem(raw: RawItem, reason: Reason): WorkItem {
  const common = {
    owner: raw.repository.owner.login,
    ownerAvatarUrl: raw.repository.owner.avatarUrl,
    repo: raw.repository.name,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    updatedAt: raw.updatedAt,
    author: raw.author?.login ?? null,
    authorAvatarUrl: raw.author?.avatarUrl ?? null,
    authorUrl: raw.author?.url ?? null,
    comments: raw.comments.totalCount,
    reasons: [reason],
  };
  if (raw.__typename === "Discussion") {
    return {
      ...common,
      type: "discussion",
      closed: raw.closed,
      stateReason: raw.stateReason,
      category: raw.category.name,
      isAnswered: raw.category.isAnswerable ? Boolean(raw.isAnswered) : null,
      locked: raw.locked,
      upvotes: raw.upvoteCount,
    };
  }
  if (raw.__typename === "Issue") return { ...common, type: "issue", state: raw.state, stateReason: raw.stateReason };
  return {
    ...common,
    type: "pr",
    state: raw.state,
    isDraft: raw.isDraft,
    reviewDecision: raw.reviewDecision,
    checks: raw.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    closes: raw.closingIssuesReferences.nodes.map((issue) => issue.url),
  };
}

// Query fields looking up items by reference, aliased b0, b1, ... A ref doesn't record its type: the number is
// looked up as issue/PR and as discussion, and whichever exists is used. The miss comes back as a NOT_FOUND
// error, which graphql() tolerates.
function refLookups(refs: ItemRef[]) {
  return {
    fields: refs.map(
      (_, i) => `b${i}: repository(owner: $o${i}, name: $r${i}) {
        issueOrPullRequest(number: $n${i}) { ${ITEM_FIELDS} }
        discussion(number: $n${i}) { ${DISCUSSION_FIELDS} }
      }`,
    ),
    params: refs.map((_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`),
    variables: Object.fromEntries(
      refs.flatMap((ref, i) => [
        [`o${i}`, ref.owner],
        [`r${i}`, ref.repo],
        [`n${i}`, ref.number],
      ]),
    ),
  };
}

const lookedUp = (data: Record<string, any>, i: number) => {
  const repo = data[`b${i}`];
  return (repo?.issueOrPullRequest ?? repo?.discussion ?? null) as RawItem | null;
};

/** Current state of specific items, null where they don't exist or aren't accessible. Reasons start empty. */
export async function fetchItemsByRef(token: string, refs: ItemRef[]): Promise<(WorkItem | null)[]> {
  if (!refs.length) return [];
  const { fields, params, variables } = refLookups(refs);
  const data = await graphql(token, `query(${params.join(", ")}) { ${fields.join("\n")} }`, variables);
  return refs.map((_, i) => {
    const raw = lookedUp(data, i);
    return raw && { ...toItem(raw, "watching"), reasons: [] };
  });
}

export async function fetchWorkView(token: string, bookmarks: ItemRef[]): Promise<GitHubWorkView> {
  const searchFields = SEARCHES.map((s) => searchField(s));
  const { fields: bookmarkFields, params, variables } = refLookups(bookmarks);

  const query = `query${params.length ? `(${params.join(", ")})` : ""} {
    viewer { login }
    ${searchFields.join("\n")}
    ${bookmarkFields.join("\n")}
  }`;
  const data = await graphql(token, query, variables);

  const byUrl = new Map<string, WorkItem>();
  const add = (raw: RawItem, reason: Reason) => {
    const existing = byUrl.get(raw.url);
    // An item updated between page requests can show up on two pages of the same search.
    if (!existing) byUrl.set(raw.url, toItem(raw, reason));
    else if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };

  // Searches with more results than fit on a page, and the cursor to continue each from.
  let cursors = new Map<Search, string>();
  const addPage = (s: Search, page: SearchPage) => {
    for (const node of page.nodes) add(node, s.reason);
    if (page.pageInfo.hasNextPage && page.pageInfo.endCursor) cursors.set(s, page.pageInfo.endCursor);
  };
  for (const s of SEARCHES) addPage(s, data[s.alias]);
  // Further pages only for the searches that need them, all in one request per round.
  for (let page = 1; page < MAX_SEARCH_PAGES && cursors.size; page++) {
    const more = [...cursors];
    cursors = new Map();
    const next = await graphql(
      token,
      `query(${more.map(([s]) => `$${s.alias}: String!`).join(", ")}) { ${more.map(([s]) => searchField(s, true)).join("\n")} }`,
      Object.fromEntries(more.map(([s, cursor]) => [s.alias, cursor])),
    );
    for (const [s] of more) addPage(s, next[s.alias]);
  }
  const truncated = [...cursors.keys()].map(({ type, reason }) => ({ type, reason }));

  const missing = bookmarks.filter((_, i) => {
    const item = lookedUp(data, i);
    if (item) add(item, "watching");
    return !item;
  });

  const items = [...byUrl.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { viewer: data.viewer.login, items, missing, truncated };
}

/** The token's GraphQL rate limit, which every board refresh and preview draws on. Checking it is free. */
export async function fetchRateLimit(token: string): Promise<RateLimit> {
  const res = await fetch("https://api.github.com/rate_limit", { headers: headers(token) });
  if (res.status === 401) throw new GitHubAuthError("GitHub rejected the session token");
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { resources } = (await res.json()) as { resources: { graphql: { limit: number; remaining: number; reset: number } } };
  const { limit, remaining, reset } = resources.graphql;
  return { limit, remaining, resetAt: new Date(reset * 1000).toISOString() };
}

const PERSON = "login avatarUrl(size: 64) url";
const COMMENT_FIELDS = `id author { ${PERSON} } bodyHTML createdAt url`;
const DETAIL_COMMON = `
  author { ${PERSON} } createdAt bodyHTML
  labels(first: 10) { nodes { name color } }
`;
// GitHub's participants are users only; bots are added from the loaded activity. Discussions have no such field.
const PARTICIPANTS = `participants(first: 50) { nodes { ${PERSON} } }`;
// The latest comments come with the details; earlier ones are loaded a page at a time (fetchEarlierComments).
// Discussions take fewer per page since each comment brings its latest replies.
const COMMENT_PAGE = 50;
const DISCUSSION_COMMENT_PAGE = 20;
const REPLY_PAGE = 20;
const PAGE_INFO = "totalCount pageInfo { hasPreviousPage startCursor }";
const DISCUSSION_COMMENT_FIELDS = `
  ${COMMENT_FIELDS} isAnswer upvoteCount
  replies(last: ${REPLY_PAGE}) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} isAnswer } }
`;
const LATEST_COMMENTS = `comments(last: ${COMMENT_PAGE}) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } }`;
// A PR's conversation is its comments and reviews together, in order, which only the timeline has. Each review
// brings its latest inline comments; filteredCount counts just these two kinds.
const REVIEW_COMMENT_PAGE = 10;
const REVIEW_COMMENT_FIELDS = `${COMMENT_FIELDS} path line originalLine diffHunk`;
const prConversation = (paged: boolean) => `comments: timelineItems(
  last: ${COMMENT_PAGE}${paged ? ", before: $before" : ""}, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW]
) {
  totalCount: filteredCount pageInfo { hasPreviousPage startCursor }
  nodes {
    __typename
    ... on IssueComment { ${COMMENT_FIELDS} }
    ... on PullRequestReview {
      ${COMMENT_FIELDS} state
      replies: comments(last: ${REVIEW_COMMENT_PAGE}) { ${PAGE_INFO} nodes { ${REVIEW_COMMENT_FIELDS} } }
    }
  }
}`;

// Issues and PRs share these timeline events; PRs add their own. Spreading a PR-only fragment into an issue's
// timeline is a GraphQL validation error, so the two lists are kept apart.
const ACTOR = `actor { ${PERSON} } createdAt`;
const SOURCE_FIELDS = "__typename number title url state repository { name owner { login } }";
const ISSUE_EVENTS = `
  __typename
  ... on IssueComment { author { ${PERSON} } createdAt url bodyText }
  ... on ClosedEvent { ${ACTOR} url stateReason }
  ... on ReopenedEvent { ${ACTOR} }
  ... on LabeledEvent { ${ACTOR} label { name color } }
  ... on UnlabeledEvent { ${ACTOR} label { name color } }
  ... on AssignedEvent { ${ACTOR} assignee { ... on Actor { ${PERSON} } } }
  ... on RenamedTitleEvent { ${ACTOR} previousTitle currentTitle }
  ... on CrossReferencedEvent {
    ${ACTOR}
    source { ... on Issue { ${SOURCE_FIELDS} stateReason } ... on PullRequest { ${SOURCE_FIELDS} isDraft } }
  }
`;
const ISSUE_EVENT_TYPES = "ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT";
const PR_EVENTS = `
  ${ISSUE_EVENTS}
  ... on PullRequestReview { author { ${PERSON} } createdAt url state bodyText }
  ... on PullRequestCommit {
    url
    commit {
      oid message messageHeadline committedDate additions deletions changedFilesIfAvailable
      statusCheckRollup { state }
      author { name user { ${PERSON} } }
    }
  }
  ... on MergedEvent { ${ACTOR} url mergeRefName commit { oid } }
  ... on HeadRefForcePushedEvent { ${ACTOR} beforeCommit { oid } afterCommit { oid } }
  ... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on Actor { ${PERSON} } ... on Team { name } } }
  ... on ReadyForReviewEvent { ${ACTOR} url }
  ... on ConvertToDraftEvent { ${ACTOR} url }
`;
const PR_EVENT_TYPES = `${ISSUE_EVENT_TYPES}, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT`;
const TIMELINE_LENGTH = 40;
const LINKED_FIELDS = "number title url state repository { name owner { login } }";

const DETAIL_QUERIES: Record<ItemType, string> = {
  pr: `pullRequest(number: $number) {
    ${DETAIL_COMMON}
    ${prConversation(false)}
    timelineItems(last: ${TIMELINE_LENGTH}, itemTypes: [${PR_EVENT_TYPES}]) { nodes { ${PR_EVENTS} } }
    closingIssuesReferences(first: 20) { nodes { ${LINKED_FIELDS} stateReason } }
    assignees(first: 10) { nodes { ${PERSON} } }
    ${PARTICIPANTS}
    baseRefName headRefName additions deletions changedFiles mergeable
    commitCount: commits { totalCount }
    files(first: 100) { nodes { path additions deletions } }
    latestOpinionatedReviews(first: 20) { nodes { author { ${PERSON} } state } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Mannequin { login } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } } } } } }
  }`,
  issue: `issue(number: $number) {
    ${DETAIL_COMMON}
    ${LATEST_COMMENTS}
    timelineItems(last: ${TIMELINE_LENGTH}, itemTypes: [${ISSUE_EVENT_TYPES}]) { nodes { ${ISSUE_EVENTS} } }
    closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${LINKED_FIELDS} isDraft } }
    assignees(first: 10) { nodes { ${PERSON} } }
    ${PARTICIPANTS}
  }`,
  discussion: `discussion(number: $number) {
    ${DETAIL_COMMON}
    comments(last: ${DISCUSSION_COMMENT_PAGE}) { ${PAGE_INFO} nodes { ${DISCUSSION_COMMENT_FIELDS} } }
    answer { ${COMMENT_FIELDS} isAnswer upvoteCount }
  }`,
};

type RawCommentPage = { totalCount: number; pageInfo: { hasPreviousPage: boolean; startCursor: string | null }; nodes: RawComment[] };
type RawComment = {
  __typename?: string;
  id: string;
  author: Person | null;
  bodyHTML: string;
  createdAt: string;
  url: string;
  isAnswer?: boolean;
  upvoteCount?: number;
  replies?: RawCommentPage;
  state?: NonNullable<ItemComment["review"]> | "PENDING";
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  diffHunk?: string;
};

function toComment(c: RawComment): ItemComment {
  return {
    id: c.id,
    author: c.author,
    bodyHTML: c.bodyHTML,
    createdAt: c.createdAt,
    url: c.url,
    isAnswer: c.isAnswer ?? false,
    upvotes: c.upvoteCount ?? null,
    replies: c.replies ? toCommentPage(c.replies) : null,
    review: c.__typename === "PullRequestReview" && c.state !== "PENDING" ? (c.state ?? null) : null,
    // Outdated comments have no current line, only the one they were made on.
    code: c.path ? { path: c.path, line: c.line ?? c.originalLine ?? null, diffHunk: c.diffHunk ?? "" } : null,
  };
}

// Left out of a PR's conversation: the viewer's own unsubmitted review, and reviews with neither text nor inline
// comments (GitHub creates those for a reply in a code thread, whose comment shows under its own review).
const shown = (c: RawComment) =>
  c.__typename !== "PullRequestReview" || (c.state !== "PENDING" && (c.state !== "COMMENTED" || c.bodyHTML !== "" || (c.replies?.totalCount ?? 0) > 0));

function toCommentPage(page: RawCommentPage): CommentPage {
  return {
    total: page.totalCount,
    latest: page.nodes.filter(shown).map(toComment),
    before: page.pageInfo.hasPreviousPage ? page.pageInfo.startCursor : null,
  };
}

// Bodies of comments and their replies, for resolving the references in them.
const commentBodies = (comments: ItemComment[]) => comments.flatMap((c) => [c.bodyHTML, ...(c.replies?.latest.map((r) => r.bodyHTML) ?? [])]);

// The details are still useful without reference states, so a failure here only costs the colors.
function resolveReferences(token: string, bodies: string[]) {
  return fetchReferences(token, bodies).catch((error): Record<string, ReferencedItem> => {
    if (error instanceof GitHubAuthError) throw error;
    console.error("Resolving references failed", error);
    return {};
  });
}
type RawContext =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl: string | null }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

function checkStatus(ctx: RawContext): CheckStatus {
  if (ctx.__typename === "StatusContext") {
    if (ctx.state === "SUCCESS") return "success";
    if (ctx.state === "FAILURE" || ctx.state === "ERROR") return "failure";
    return "pending";
  }
  if (ctx.status !== "COMPLETED") return "pending";
  if (ctx.conclusion === "SUCCESS") return "success";
  if (ctx.conclusion === "NEUTRAL") return "neutral";
  if (ctx.conclusion === "SKIPPED") return "skipped";
  return "failure";
}

// A timeline node as requested by ISSUE_EVENTS / PR_EVENTS; which fields are set depends on __typename.
type RawEvent = {
  __typename: string;
  actor?: Person | null;
  author?: Person | null;
  createdAt?: string;
  url?: string;
  stateReason?: string | null;
  state?: string;
  label?: { name: string; color: string };
  assignee?: Person | null;
  requestedReviewer?: (Partial<Person> & { name?: string }) | null;
  previousTitle?: string;
  currentTitle?: string;
  bodyText?: string;
  // Empty when the referencing item is neither an issue nor a PR (or not visible).
  source?: (RawLinked & { __typename: "Issue" | "PullRequest" }) | { __typename?: undefined };
  mergeRefName?: string;
  beforeCommit?: { oid: string } | null;
  afterCommit?: { oid: string } | null;
  commit?: {
    oid: string;
    message?: string;
    messageHeadline?: string;
    committedDate?: string;
    additions?: number;
    deletions?: number;
    changedFilesIfAvailable?: number | null;
    statusCheckRollup?: { state: NonNullable<PullRequest["checks"]> } | null;
    author?: { name: string | null; user: Person | null } | null;
  } | null;
};

const EVENT_KINDS: Record<string, TimelineEvent["kind"]> = {
  IssueComment: "commented",
  PullRequestReview: "reviewed",
  PullRequestCommit: "committed",
  HeadRefForcePushedEvent: "force_pushed",
  MergedEvent: "merged",
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  AssignedEvent: "assigned",
  ReviewRequestedEvent: "review_requested",
  ReadyForReviewEvent: "ready_for_review",
  ConvertToDraftEvent: "converted_to_draft",
  RenamedTitleEvent: "renamed",
  CrossReferencedEvent: "referenced",
};

function timelineEvent(e: RawEvent): TimelineEvent | null {
  const kind = EVENT_KINDS[e.__typename];
  if (!kind) return null;
  if (kind === "committed" && e.commit) {
    const c = e.commit;
    // Commits whose email isn't linked to a GitHub account only have a git name.
    const actor = c.author?.user ?? (c.author?.name ? { login: c.author.name, avatarUrl: "", url: null } : null);
    return {
      kind,
      actor,
      createdAt: c.committedDate!,
      detail: c.messageHeadline!,
      url: e.url ?? null,
      commit: {
        sha: c.oid,
        message: c.message!,
        additions: c.additions!,
        deletions: c.deletions!,
        changedFiles: c.changedFilesIfAvailable ?? null,
        checks: c.statusCheckRollup?.state ?? null,
      },
    };
  }
  // A team asked to review has only a name.
  const reviewer = e.requestedReviewer;
  const subject =
    e.assignee ??
    (reviewer?.login
      ? { login: reviewer.login, avatarUrl: reviewer.avatarUrl ?? "", url: reviewer.url ?? null }
      : reviewer?.name
        ? { login: reviewer.name, avatarUrl: "", url: null }
        : undefined);
  const source = e.source?.__typename ? linkedItem(e.source, e.source.__typename === "PullRequest" ? "pr" : "issue") : undefined;
  const detail = e.label?.name ?? subject?.login ?? e.currentTitle ?? source?.title ?? e.state ?? e.stateReason ?? null;
  return {
    kind,
    actor: e.actor ?? e.author ?? null,
    createdAt: e.createdAt!,
    detail,
    url: source?.url ?? e.url ?? null,
    ...(e.label && { label: e.label }),
    ...(subject && { subject }),
    ...(e.previousTitle !== undefined && { previousTitle: e.previousTitle }),
    ...(e.bodyText && { excerpt: excerpt(e.bodyText) }),
    ...(source && { source }),
    ...(kind === "merged" && e.commit && { merge: { sha: e.commit.oid, into: e.mergeRefName ?? "" } }),
    ...(kind === "force_pushed" && { forcePush: { before: e.beforeCommit?.oid ?? null, after: e.afterCommit?.oid ?? null } }),
  };
}

type RawLinked = {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: Issue["stateReason"];
  isDraft?: boolean;
  repository: { name: string; owner: { login: string } };
};

function linkedItem(raw: RawLinked, type: "pr" | "issue"): LinkedItem {
  const base = { owner: raw.repository.owner.login, repo: raw.repository.name, number: raw.number, title: raw.title, url: raw.url };
  return type === "pr"
    ? { ...base, type, state: raw.state as PullRequest["state"], isDraft: raw.isDraft ?? false }
    : { ...base, type, state: raw.state as Issue["state"], stateReason: raw.stateReason ?? null };
}

// Discussions have no timeline API, so theirs is built from the latest comments and replies.
function discussionTimeline(comments: ItemComment[]): TimelineEvent[] {
  return comments.flatMap((c) => [c, ...(c.replies?.latest ?? [])]).map((c) => ({
    kind: "commented",
    actor: c.author,
    createdAt: c.createdAt,
    detail: c.isAnswer ? "ANSWER" : null,
    url: c.url,
  }));
}

const REFERENCE_LIMIT = 50;
const EXCERPT_LENGTH = 200;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…` : flat;
}

// Resolves the issue, PR and discussion links in bodies (see referenceLinkKind) in one query.
async function fetchReferences(token: string, htmls: string[]): Promise<Record<string, ReferencedItem>> {
  const refs = new Map<string, { owner: string; repo: string; number: number; discussion: boolean }>();
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  for (const html of htmls) {
    // The text is what sits directly inside the link; references are plain "#123" text.
    for (const [, tag, text] of html.matchAll(/(<a [^>]*>)([^<]*)/g)) {
      const href = attr(tag!, "href") ?? "";
      const kind = referenceLinkKind({ className: attr(tag!, "class") ?? "", text: text!, href, hovercardType: attr(tag!, "data-hovercard-type") });
      const key = kind && referenceKey(attr(tag!, "data-url") ?? href);
      if (!key || refs.has(key) || refs.size >= REFERENCE_LIMIT) continue;
      const [, owner, repo, number] = /^(.+)\/(.+)#(\d+)$/.exec(key)!;
      refs.set(key, { owner: owner!, repo: repo!, number: Number(number), discussion: kind === "discussion" });
    }
  }
  if (refs.size === 0) return {};
  // Owner and repo are limited to [\w.-] by referenceKey, so they're safe to inline as string literals.
  const fields = `number title url createdAt bodyText author { ${PERSON} } repository { name owner { login } }`;
  const aliases = [...refs.values()].map(
    (r, i) => `r${i}: repository(owner: "${r.owner}", name: "${r.repo}") {
      ${r.discussion ? `item: discussion(number: ${r.number}) { __typename ${fields} closed stateReason }`
        : `item: issueOrPullRequest(number: ${r.number}) {
          __typename
          ... on Issue { ${fields} state stateReason }
          ... on PullRequest { ${fields} state isDraft }
        }`}
    }`,
  );
  const data = await graphql(token, `query { ${aliases.join("\n")} }`, {});
  const references: Record<string, ReferencedItem> = {};
  for (const repo of Object.values(data)) {
    const raw = repo?.item;
    if (!raw) continue;
    const summary = { author: raw.author, createdAt: raw.createdAt, excerpt: excerpt(raw.bodyText) };
    const item: ReferencedItem =
      raw.__typename === "Discussion"
        ? { owner: raw.repository.owner.login, repo: raw.repository.name, number: raw.number, title: raw.title, url: raw.url, type: "discussion", closed: raw.closed, stateReason: raw.stateReason, ...summary }
        : { ...linkedItem(raw, raw.__typename === "PullRequest" ? "pr" : "issue"), ...summary };
    references[`${item.owner}/${item.repo}#${item.number}`.toLowerCase()] = item;
  }
  return references;
}

// Everyone with a GitHub account who took part, in order of first appearance. Commit authors without an account
// (no url) are left out.
function involved(people: (Person | null)[]): Person[] {
  const seen = new Map<string, Person>();
  for (const p of people) if (p?.url && !seen.has(p.login.toLowerCase())) seen.set(p.login.toLowerCase(), p);
  return [...seen.values()];
}

// Failures first so the reason a PR is red is visible without scrolling.
const CHECK_ORDER: CheckStatus[] = ["failure", "pending", "success", "neutral", "skipped"];

export async function fetchItemDetails(token: string, type: ItemType, ref: ItemRef): Promise<ItemDetails | null> {
  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { item: ${DETAIL_QUERIES[type]} }
  }`;
  const data = await graphql(token, query, { owner: ref.owner, repo: ref.repo, number: ref.number });
  const raw = data.repository?.item;
  if (!raw) return null;

  const commentPage = toCommentPage(raw.comments);
  const comments = commentPage.latest;
  const answer = type === "discussion" && raw.answer ? toComment(raw.answer) : null;
  const references = await resolveReferences(token, [raw.bodyHTML, ...commentBodies([...comments, ...(answer ? [answer] : [])])]);
  const timeline =
    type === "discussion"
      ? discussionTimeline(comments)
      : (raw.timelineItems.nodes as RawEvent[]).map(timelineEvent).filter((e) => e !== null);
  return {
    author: raw.author,
    involved: involved([
      raw.author,
      ...(raw.participants?.nodes ?? []),
      ...(raw.assignees?.nodes ?? []),
      ...(raw.latestOpinionatedReviews?.nodes.map((r: { author: Person | null }) => r.author) ?? []),
      ...[...comments, ...(answer ? [answer] : [])].flatMap((c) => [c.author, ...(c.replies?.latest.map((r) => r.author) ?? [])]),
      ...timeline.map((e) => e.actor),
    ]),
    createdAt: raw.createdAt,
    bodyHTML: raw.bodyHTML,
    labels: raw.labels?.nodes ?? [],
    assignees: raw.assignees?.nodes ?? [],
    comments: commentPage,
    timeline: timeline.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    linked:
      type === "pr"
        ? (raw.closingIssuesReferences.nodes as RawLinked[]).map((n) => linkedItem(n, "issue"))
        : type === "issue"
          ? (raw.closedByPullRequestsReferences.nodes as RawLinked[]).map((n) => linkedItem(n, "pr"))
          : [],
    pr:
      type === "pr"
        ? {
            baseRef: raw.baseRefName,
            headRef: raw.headRefName,
            additions: raw.additions,
            deletions: raw.deletions,
            changedFiles: raw.changedFiles,
            commits: raw.commitCount.totalCount,
            files: raw.files?.nodes ?? [],
            mergeable: raw.mergeable,
            reviews: raw.latestOpinionatedReviews.nodes,
            requestedReviewers: raw.reviewRequests.nodes
              .map((r: { requestedReviewer: { login?: string; name?: string } | null }) => r.requestedReviewer?.login ?? r.requestedReviewer?.name)
              .filter(Boolean),
            checks: ((raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) as RawContext[])
              .map((ctx) => ({
                name: ctx.__typename === "CheckRun" ? ctx.name : ctx.context,
                status: checkStatus(ctx),
                url: ctx.__typename === "CheckRun" ? ctx.detailsUrl : ctx.targetUrl,
              }))
              .sort((a, b) => CHECK_ORDER.indexOf(a.status) - CHECK_ORDER.indexOf(b.status)),
          }
        : null,
    references,
    discussion: type === "discussion" ? { answer } : null,
  };
}

export async function fetchProfile(token: string, login: string): Promise<ProfileSummary | null> {
  const data = await graphql(
    token,
    `query($login: String!) { repositoryOwner(login: $login) {
      __typename login avatarUrl(size: 96) url
      ... on User { name bio location createdAt }
      ... on Organization { name description location createdAt }
    } }`,
    { login },
  );
  const raw = data.repositoryOwner;
  if (!raw) return null;
  return {
    login: raw.login,
    name: raw.name || null,
    avatarUrl: raw.avatarUrl,
    url: raw.url,
    bio: raw.bio || raw.description || null,
    location: raw.location || null,
    createdAt: raw.createdAt,
  };
}

// Everything the AI summary reads about an item, as plain text: markdown bodies rather than rendered HTML, every
// comment rather than the latest few, and no diff (the file list and commit messages stand in for it).
const CONTEXT_LINKED = "number title url state repository { nameWithOwner }";
const CONTEXT_COMMON = `
  title url createdAt updatedAt author { login } body
  labels(first: 30) { nodes { name } }
`;
const CONTEXT_QUERIES: Record<ItemType, string> = {
  pr: `pullRequest(number: $number) {
    ${CONTEXT_COMMON}
    state isDraft mergeable reviewDecision baseRefName headRefName additions deletions changedFiles
    milestone { title }
    assignees(first: 20) { nodes { login } }
    participants(first: 100) { nodes { login } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Mannequin { login } } } }
    closingIssuesReferences(first: 20) { nodes { ${CONTEXT_LINKED} } }
    files(first: 100) { nodes { path additions deletions } }
    commits(last: 100) { totalCount nodes { commit { messageHeadline author { name user { login } } } } }
    reviews(first: 100) { nodes { author { login } state body submittedAt } }
    reviewThreads(first: 100) { nodes { path isResolved comments(first: 30) { nodes { author { login } body createdAt } } } }
    timelineItems(last: 100, itemTypes: [${PR_EVENT_TYPES}]) { nodes { ${PR_EVENTS} } }
    statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } } } } } }
  }`,
  issue: `issue(number: $number) {
    ${CONTEXT_COMMON}
    state stateReason
    milestone { title }
    assignees(first: 20) { nodes { login } }
    participants(first: 100) { nodes { login } }
    closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${CONTEXT_LINKED} } }
    timelineItems(last: 100, itemTypes: [${ISSUE_EVENT_TYPES}]) { nodes { ${ISSUE_EVENTS} } }
  }`,
  discussion: `discussion(number: $number) {
    ${CONTEXT_COMMON}
    closed stateReason isAnswered locked upvoteCount
    category { name }
    answer { author { login } body }
  }`,
};
const CONTEXT_COMMENT = "author { login } body createdAt";
const CONTEXT_COMMENT_FIELDS: Record<ItemType, string> = {
  pr: CONTEXT_COMMENT,
  issue: CONTEXT_COMMENT,
  discussion: `${CONTEXT_COMMENT} isAnswer replies(first: 50) { nodes { ${CONTEXT_COMMENT} } }`,
};
const CONTEXT_FIELD: Record<ItemType, string> = { pr: "pullRequest", issue: "issue", discussion: "discussion" };
// 100 per page; threads longer than this are rare and the summary leans on the latest activity anyway.
const MAX_COMMENT_PAGES = 10;

type ContextComment = { author: { login: string } | null; body: string; createdAt: string; isAnswer?: boolean; replies?: { nodes: ContextComment[] } };
type ContextLinked = { number: number; title: string; url: string; state: string; repository: { nameWithOwner: string } };

const who = (author: { login: string } | null | undefined) => (author ? `@${author.login}` : "(deleted user)");
const day = (iso: string) => iso.slice(0, 10);
const logins = (nodes: { login?: string }[] | undefined) => (nodes ?? []).map((n) => n.login && `@${n.login}`).filter(Boolean).join(", ") || "none";

async function fetchAllComments(token: string, type: ItemType, ref: ItemRef) {
  const comments: ContextComment[] = [];
  let after: string | null = null;
  let total = 0;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const data = await graphql(
      token,
      `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) { item: ${CONTEXT_FIELD[type]}(number: $number) {
          comments(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${CONTEXT_COMMENT_FIELDS[type]} } }
        } }
      }`,
      { owner: ref.owner, repo: ref.repo, number: ref.number, after },
    );
    const page_ = data.repository?.item?.comments;
    if (!page_) break;
    total = page_.totalCount;
    comments.push(...page_.nodes);
    if (!page_.pageInfo.hasNextPage) break;
    after = page_.pageInfo.endCursor;
  }
  return { comments, total };
}

/** The item and its surroundings as a plain-text document for the AI summary, or null if it doesn't exist. */
export async function fetchItemContext(token: string, type: ItemType, ref: ItemRef): Promise<{ updatedAt: string; text: string } | null> {
  const [data, { comments, total }] = await Promise.all([
    graphql(
      token,
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          nameWithOwner description
          primaryLanguage { name }
          repositoryTopics(first: 10) { nodes { topic { name } } }
          item: ${CONTEXT_QUERIES[type]}
        }
      }`,
      { owner: ref.owner, repo: ref.repo, number: ref.number },
    ),
    fetchAllComments(token, type, ref),
  ]);
  const repo = data.repository;
  const raw = repo?.item;
  if (!raw) return null;

  const out: string[] = [];
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, ...lines, "");
  const linked = (nodes: ContextLinked[]) => nodes.map((n) => `- ${n.repository.nameWithOwner}#${n.number} (${n.state.toLowerCase()}): ${n.title}`);

  section("Repository", [
    `${repo.nameWithOwner}${repo.description ? `: ${repo.description}` : ""}`,
    `Language: ${repo.primaryLanguage?.name ?? "unknown"}; topics: ${repo.repositoryTopics.nodes.map((n: { topic: { name: string } }) => n.topic.name).join(", ") || "none"}`,
  ]);

  const kind = { pr: "Pull request", issue: "Issue", discussion: "Discussion" }[type];
  const state =
    type === "discussion"
      ? [raw.closed ? `closed${raw.stateReason ? ` (${raw.stateReason.toLowerCase()})` : ""}` : "open", raw.locked && "locked", raw.isAnswered && "answered"]
      : type === "issue"
        ? [raw.state.toLowerCase(), raw.stateReason && raw.state === "CLOSED" && `(${raw.stateReason.toLowerCase()})`]
        : [raw.state.toLowerCase(), raw.isDraft && "draft", raw.reviewDecision && `review decision: ${raw.reviewDecision.toLowerCase()}`, raw.state === "OPEN" && `mergeable: ${raw.mergeable.toLowerCase()}`];
  section(kind, [
    `${repo.nameWithOwner}#${ref.number}: ${raw.title}`,
    `URL: ${raw.url}`,
    `Author: ${who(raw.author)}; opened ${day(raw.createdAt)}; last updated ${day(raw.updatedAt)}`,
    `State: ${state.filter(Boolean).join(", ")}`,
    `Labels: ${raw.labels.nodes.map((l: { name: string }) => l.name).join(", ") || "none"}`,
    ...(type === "discussion" ? [`Category: ${raw.category.name}; upvotes: ${raw.upvoteCount}`] : []),
    ...(raw.milestone ? [`Milestone: ${raw.milestone.title}`] : []),
    ...(raw.assignees ? [`Assignees: ${logins(raw.assignees.nodes)}`] : []),
    ...(raw.participants ? [`Participants: ${logins(raw.participants.nodes)}`] : []),
  ]);
  section("Description", [raw.body.trim() || "(empty)"]);

  if (type === "pr") {
    const requested = raw.reviewRequests.nodes.map((r: { requestedReviewer: { login?: string; name?: string } | null }) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean);
    section("Branch and size", [
      `${raw.headRefName} → ${raw.baseRefName}; ${raw.changedFiles} files changed, +${raw.additions} −${raw.deletions}`,
      `Requested reviewers: ${requested.join(", ") || "none"}`,
    ]);
    section("Closes", linked(raw.closingIssuesReferences.nodes));
    section(`Changed files${raw.changedFiles > 100 ? " (first 100)" : ""}`, raw.files.nodes.map((f: { path: string; additions: number; deletions: number }) => `- ${f.path} (+${f.additions} −${f.deletions})`));
    section(
      `Commits (${raw.commits.totalCount}${raw.commits.totalCount > 100 ? ", latest 100" : ""})`,
      raw.commits.nodes.map((n: { commit: { messageHeadline: string; author: { name: string | null; user: { login: string } | null } | null } }) =>
        `- ${n.commit.messageHeadline} (${n.commit.author?.user ? `@${n.commit.author.user.login}` : (n.commit.author?.name ?? "unknown")})`,
      ),
    );
    const checks = ((raw.statusCheckRollup.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) as RawContext[]).map(
      (ctx) => `- ${ctx.__typename === "CheckRun" ? ctx.name : ctx.context}: ${checkStatus(ctx)}`,
    );
    section("Checks on the latest commit", checks);
    section(
      "Reviews",
      raw.reviews.nodes.map((r: { author: { login: string } | null; state: string; body: string; submittedAt: string | null }) =>
        `- [${r.submittedAt ? day(r.submittedAt) : "pending"}] ${who(r.author)} ${r.state.toLowerCase()}${r.body.trim() ? `: ${r.body.trim()}` : ""}`,
      ),
    );
    section(
      "Review threads on code",
      raw.reviewThreads.nodes.flatMap((t: { path: string; isResolved: boolean; comments: { nodes: ContextComment[] } }) => [
        `- ${t.path} (${t.isResolved ? "resolved" : "unresolved"})`,
        ...t.comments.nodes.map((c) => `  - [${day(c.createdAt)}] ${who(c.author)}: ${c.body.trim()}`),
      ]),
    );
  }
  if (type === "issue") section("Closed by pull requests", linked(raw.closedByPullRequestsReferences.nodes));
  if (type === "discussion" && raw.answer) section("Accepted answer", [`${who(raw.answer.author)}: ${raw.answer.body.trim()}`]);

  section(
    `Conversation (${total} comments${comments.length < total ? `, first ${comments.length} shown` : ""})`,
    comments.flatMap((c) => [
      `- [${day(c.createdAt)}] ${who(c.author)}${c.isAnswer ? " (accepted answer)" : ""}: ${c.body.trim()}`,
      ...(c.replies?.nodes ?? []).map((r) => `  - [${day(r.createdAt)}] ${who(r.author)}: ${r.body.trim()}`),
    ]),
  );
  // Comments, reviews and commits are covered above; the timeline adds state changes and cross-references.
  if (type !== "discussion") {
    section(
      "Other activity",
      (raw.timelineItems.nodes as RawEvent[])
        .map(timelineEvent)
        .filter((e) => e !== null && !["commented", "reviewed", "committed"].includes(e.kind))
        .map((e) => `- [${day(e!.createdAt)}] ${who(e!.actor)} ${e!.kind.replace(/_/g, " ")}${e!.detail ? `: ${e!.detail}` : ""}${e!.kind === "referenced" && e!.url ? ` (${e!.url})` : ""}`),
    );
  }
  return { updatedAt: raw.updatedAt, text: out.join("\n") };
}

// Pages of a REST list, up to `maxPages` of 100. Returns the items and whether GitHub has more.
async function restPages<T>(token: string, path: string, maxPages: number, pick: (body: any) => T[]): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`https://api.github.com${path}${sep}per_page=100&page=${page}`, {
      headers: { ...headers(token), Accept: "application/vnd.github+json" },
    });
    if (res.status === 401) throw new GitHubAuthError("GitHub rejected the session token");
    if (res.status === 404) return { items, truncated: false };
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    items.push(...pick(await res.json()));
    if (!/rel="next"/.test(res.headers.get("Link") ?? "")) return { items, truncated: false };
  }
  return { items, truncated: true };
}

type RawFile = { filename: string; previous_filename?: string; status: DiffFile["status"]; additions: number; deletions: number; patch?: string };
const toDiffFile = (f: RawFile): DiffFile => ({
  path: f.filename,
  previousPath: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
});

const repoPath = (ref: { owner: string; repo: string }) => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

/** A PR's commits, oldest first. GitHub's endpoint stops at 250. */
export async function fetchCommits(token: string, ref: ItemRef): Promise<CommitList> {
  type RawCommit = {
    sha: string;
    html_url: string;
    commit: { message: string; author: { name: string; date: string } | null };
    author: { login: string; avatar_url: string; html_url: string } | null;
  };
  const { items, truncated } = await restPages(token, `${repoPath(ref)}/pulls/${ref.number}/commits`, 3, (body: RawCommit[]) =>
    body.map(
      (c): Commit => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.author ? { login: c.author.login, avatarUrl: c.author.avatar_url, url: c.author.html_url } : null,
        authorName: c.commit.author?.name ?? "unknown",
        authoredAt: c.commit.author?.date ?? "",
        url: c.html_url,
      }),
    ),
  );
  return { commits: items, truncated };
}

/** The files changed by a whole PR, or by one commit when `sha` is given. */
export async function fetchDiff(token: string, ref: ItemRef, sha: string | null): Promise<Diff> {
  const { items, truncated } = sha
    ? await restPages(token, `${repoPath(ref)}/commits/${sha}`, 3, (body: { files?: RawFile[] }) => (body.files ?? []).map(toDiffFile))
    : await restPages(token, `${repoPath(ref)}/pulls/${ref.number}/files`, 3, (body: RawFile[]) => body.map(toDiffFile));
  return { files: items, truncated };
}

/**
 * The page of comments before `before` on an issue, PR (comments and reviews) or discussion, or with `replyTo` (a
 * discussion comment's or a review's id) the replies or inline comments before it. Oldest first, with the references in their bodies resolved.
 */
export async function fetchEarlierComments(
  token: string,
  target: { type: ItemType; ref: ItemRef } | { replyTo: string },
  before: string,
): Promise<EarlierComments | null> {
  let page: RawCommentPage | undefined;
  if ("replyTo" in target) {
    const data = await graphql(
      token,
      `query($id: ID!, $before: String!) { node(id: $id) {
        ... on DiscussionComment { replies(last: ${COMMENT_PAGE}, before: $before) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} isAnswer } } }
        ... on PullRequestReview { replies: comments(last: ${COMMENT_PAGE}, before: $before) { ${PAGE_INFO} nodes { ${REVIEW_COMMENT_FIELDS} } } }
      } }`,
      { id: target.replyTo, before },
    );
    page = data.node?.replies;
  } else {
    const comments =
      target.type === "discussion"
        ? `discussion(number: $number) { comments(last: ${DISCUSSION_COMMENT_PAGE}, before: $before) { ${PAGE_INFO} nodes { ${DISCUSSION_COMMENT_FIELDS} } } }`
        : target.type === "pr"
          ? `pullRequest(number: $number) { ${prConversation(true)} }`
          : `issue(number: $number) { comments(last: ${COMMENT_PAGE}, before: $before) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } } }`;
    const data = await graphql(
      token,
      `query($owner: String!, $repo: String!, $number: Int!, $before: String!) { repository(owner: $owner, name: $repo) { item: ${comments} } }`,
      { owner: target.ref.owner, repo: target.ref.repo, number: target.ref.number, before },
    );
    page = data.repository?.item?.comments;
  }
  if (!page) return null;
  const { latest, before: earlier } = toCommentPage(page);
  return { comments: latest, before: earlier, references: await resolveReferences(token, commentBodies(latest)) };
}
