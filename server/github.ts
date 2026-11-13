import type { ItemRef } from "./db.ts";
import type {
  CheckStatus,
  Discussion,
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
import { referenceKey } from "./types.ts";

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
const COMMENT_FIELDS = `author { ${PERSON} } bodyHTML createdAt url`;
const DETAIL_COMMON = `
  author { ${PERSON} } createdAt bodyHTML
  labels(first: 10) { nodes { name color } }
`;
// GitHub's participants are users only; bots are added from the loaded activity. Discussions have no such field.
const PARTICIPANTS = `participants(first: 50) { nodes { ${PERSON} } }`;
const LATEST_COMMENTS = `comments(last: 5) { totalCount nodes { ${COMMENT_FIELDS} } }`;

// Issues and PRs share these timeline events; PRs add their own. Spreading a PR-only fragment into an issue's
// timeline is a GraphQL validation error, so the two lists are kept apart.
const ACTOR = `actor { ${PERSON} } createdAt`;
const ISSUE_EVENTS = `
  __typename
  ... on IssueComment { author { ${PERSON} } createdAt url }
  ... on ClosedEvent { ${ACTOR} url stateReason }
  ... on ReopenedEvent { ${ACTOR} }
  ... on LabeledEvent { ${ACTOR} label { name } }
  ... on UnlabeledEvent { ${ACTOR} label { name } }
  ... on AssignedEvent { ${ACTOR} assignee { ... on User { login } ... on Bot { login } } }
  ... on RenamedTitleEvent { ${ACTOR} currentTitle }
  ... on CrossReferencedEvent { ${ACTOR} source { ... on Issue { title url } ... on PullRequest { title url } } }
`;
const ISSUE_EVENT_TYPES = "ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT";
const PR_EVENTS = `
  ${ISSUE_EVENTS}
  ... on PullRequestReview { author { ${PERSON} } createdAt url state }
  ... on PullRequestCommit { url commit { committedDate author { name user { ${PERSON} } } } }
  ... on MergedEvent { ${ACTOR} url }
  ... on HeadRefForcePushedEvent { ${ACTOR} }
  ... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Team { name } ... on Mannequin { login } } }
  ... on ReadyForReviewEvent { ${ACTOR} url }
  ... on ConvertToDraftEvent { ${ACTOR} url }
`;
const PR_EVENT_TYPES = `${ISSUE_EVENT_TYPES}, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT`;
const TIMELINE_LENGTH = 40;
const LINKED_FIELDS = "number title url state repository { name owner { login } }";

const DETAIL_QUERIES: Record<ItemType, string> = {
  pr: `pullRequest(number: $number) {
    ${DETAIL_COMMON}
    ${LATEST_COMMENTS}
    timelineItems(last: ${TIMELINE_LENGTH}, itemTypes: [${PR_EVENT_TYPES}]) { nodes { ${PR_EVENTS} } }
    closingIssuesReferences(first: 20) { nodes { ${LINKED_FIELDS} stateReason } }
    assignees(first: 10) { nodes { ${PERSON} } }
    ${PARTICIPANTS}
    baseRefName headRefName additions deletions changedFiles mergeable
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
    comments(last: 5) { totalCount nodes {
      ${COMMENT_FIELDS} isAnswer upvoteCount
      replies(last: 3) { totalCount nodes { ${COMMENT_FIELDS} isAnswer } }
    } }
    answer { ${COMMENT_FIELDS} isAnswer upvoteCount }
  }`,
};

type RawComment = {
  author: Person | null;
  bodyHTML: string;
  createdAt: string;
  url: string;
  isAnswer?: boolean;
  upvoteCount?: number;
  replies?: { totalCount: number; nodes: RawComment[] };
};
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
  label?: { name: string };
  assignee?: { login?: string } | null;
  requestedReviewer?: { login?: string; name?: string } | null;
  currentTitle?: string;
  source?: { title?: string; url?: string };
  commit?: { committedDate: string; author: { name: string | null; user: Person | null } | null };
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
  if (e.commit) {
    const author = e.commit.author;
    // Commits whose email isn't linked to a GitHub account only have a git name.
    const actor = author?.user ?? (author?.name ? { login: author.name, avatarUrl: "", url: null } : null);
    return { kind, actor, createdAt: e.commit.committedDate, detail: null, url: e.url ?? null };
  }
  const detail =
    e.label?.name ??
    e.assignee?.login ??
    e.requestedReviewer?.login ??
    e.requestedReviewer?.name ??
    e.currentTitle ??
    e.source?.title ??
    e.state ??
    e.stateReason ??
    null;
  return { kind, actor: e.actor ?? e.author ?? null, createdAt: e.createdAt!, detail, url: e.source?.url ?? e.url ?? null };
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

// Resolves the issue, PR and discussion links GitHub rendered into bodies (`<a class="issue-link" ...>`) in one query.
async function fetchReferences(token: string, htmls: string[]): Promise<Record<string, ReferencedItem>> {
  const refs = new Map<string, { owner: string; repo: string; number: number; discussion: boolean }>();
  for (const html of htmls) {
    for (const [tag] of html.matchAll(/<a [^>]*class="issue-link[^>]*>/g)) {
      const url = /data-url="([^"]+)"/.exec(tag)?.[1];
      const key = url && referenceKey(url);
      if (!key || refs.has(key) || refs.size >= REFERENCE_LIMIT) continue;
      const [, owner, repo, number] = /^(.+)\/(.+)#(\d+)$/.exec(key)!;
      refs.set(key, { owner, repo, number: Number(number), discussion: /data-hovercard-type="discussion"/.test(tag) });
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

  const comment = (c: RawComment): ItemComment => ({
    author: c.author,
    bodyHTML: c.bodyHTML,
    createdAt: c.createdAt,
    url: c.url,
    isAnswer: c.isAnswer ?? false,
    upvotes: c.upvoteCount ?? null,
    replies: c.replies ? { total: c.replies.totalCount, latest: c.replies.nodes.map(comment) } : null,
  });
  const comments = (raw.comments.nodes as RawComment[]).map(comment);
  const answer = type === "discussion" && raw.answer ? comment(raw.answer) : null;
  const bodies = [raw.bodyHTML, ...[...comments, ...(answer ? [answer] : [])].flatMap((c) => [c.bodyHTML, ...(c.replies?.latest.map((r) => r.bodyHTML) ?? [])])];
  // The details are still useful without reference states, so a failure here only costs the colors.
  const references = await fetchReferences(token, bodies).catch((error) => {
    if (error instanceof GitHubAuthError) throw error;
    console.error("Resolving references failed", error);
    return {};
  });
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
    comments: { total: raw.comments.totalCount, latest: comments },
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
