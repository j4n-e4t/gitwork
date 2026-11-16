// Fixtures for demo mode (dev only, `?demo` in the URL): the API client answers from here instead of the server, so
// the app runs without signing in. Writes are accepted and dropped. Shapes follow server/types.ts.
import type { CommentPage, Commit, Diff, DiffFile, EarlierComments, ItemComment, ItemDetails, Person, TimelineEvent, WorkItem, WorkView } from "../../../server/types.ts";

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const person = (login: string): Person => ({ login, avatarUrl: `https://github.com/${login}.png?size=64`, url: `https://github.com/${login}` });
const me = person("octocat");
const alice = person("defunkt");
const bob = person("mojombo");

const base = { owner: "acme", ownerAvatarUrl: "https://github.com/github.png?size=64", repo: "web", authorUrl: null };
type Fields = WorkItem extends infer T ? (T extends WorkItem ? Omit<T, keyof typeof base | "url"> : never) : never;
const item = (fields: Fields) =>
  ({ ...base, url: `https://github.com/acme/web/${{ pr: "pull", issue: "issues", discussion: "discussions" }[fields.type]}/${fields.number}`, ...fields }) as WorkItem;

const items: WorkItem[] = [
  item({ type: "pr", number: 412, title: "Add integration browser with search and categories", updatedAt: ago(1), author: me.login, authorAvatarUrl: me.avatarUrl, comments: 3, reasons: ["authored"], state: "OPEN", isDraft: false, reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE" }),
  item({ type: "pr", number: 409, title: "Fix ripple position in RTL layouts", updatedAt: ago(5), author: alice.login, authorAvatarUrl: alice.avatarUrl, comments: 1, reasons: ["review"], state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS" }),
  item({ type: "pr", number: 398, title: "Draft: migrate settings to the new form library", updatedAt: ago(30), author: me.login, authorAvatarUrl: me.avatarUrl, comments: 0, reasons: ["authored"], state: "OPEN", isDraft: true, reviewDecision: null, checks: "PENDING" }),
  item({ type: "issue", number: 405, title: "Integration list doesn't scroll on Safari", updatedAt: ago(3), author: bob.login, authorAvatarUrl: bob.avatarUrl, comments: 2, reasons: ["assigned", "mentioned"], state: "OPEN", stateReason: null }),
  item({ type: "issue", number: 377, title: "Dark mode contrast in the sidebar", updatedAt: ago(400), author: me.login, authorAvatarUrl: me.avatarUrl, comments: 0, reasons: ["authored"], state: "OPEN", stateReason: null }),
  item({ type: "discussion", number: 380, title: "RFC: plugin API for custom cards", updatedAt: ago(12), author: alice.login, authorAvatarUrl: alice.avatarUrl, comments: 4, reasons: ["commented"], closed: false, stateReason: null, category: "Ideas", isAnswered: null, locked: false, upvotes: 7 }),
];

const work: WorkView = { viewer: me.login, items, missing: [], hidden: [], columnOrder: null, precedence: null, dismissed: [], stale: false, truncated: [] };

const comment = (author: Person, html: string, hours: number, n: number, replies: CommentPage | null = null): ItemComment => ({
  id: `comment-${n}`,
  author,
  bodyHTML: html,
  createdAt: ago(hours),
  url: `https://github.com/acme/web/pull/412#issuecomment-${n}`,
  isAnswer: false,
  upvotes: null,
  replies,
  review: null,
  code: null,
});

// A review with its verdict and inline comments, for PR conversations.
const review = (author: Person, state: NonNullable<ItemComment["review"]>, html: string, hours: number, n: number, inline: ItemComment[]): ItemComment => ({
  ...comment(author, html, hours, n, inline.length ? { total: inline.length, latest: inline, before: null } : null),
  url: `https://github.com/acme/web/pull/412#pullrequestreview-${n}`,
  review: state,
});
const inline = (author: Person, html: string, hours: number, n: number, path: string, line: number, diffHunk: string): ItemComment => ({
  ...comment(author, html, hours, n),
  url: `https://github.com/acme/web/pull/412#discussion_r${n}`,
  code: { path, line, diffHunk },
});

// Older comments and replies, served a page at a time by /api/comments to try the "Load earlier" buttons. A cursor
// is the number of items still before it.
const PAGE = 3;
const earlierComments = Array.from({ length: 6 }, (_, i) => comment([alice, bob, me][i % 3]!, `<p>Earlier comment ${i + 1}.</p>`, 70 - i * 8, 100 + i));
const threadReplies = Array.from({ length: 5 }, (_, i) => comment([bob, me][i % 2]!, `<p>Reply ${i + 1} in the thread.</p>`, 18 - i * 3, 200 + i));
const page = (all: ItemComment[], before: string): EarlierComments => {
  const end = Number(before);
  const start = Math.max(0, end - PAGE);
  return { comments: all.slice(start, end), before: start > 0 ? String(start) : null, references: {} };
};

// GitHub's markup for an @-mention in bodyHTML.
const mention = (login: string) => `<a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/${login}">@${login}</a>`;

// GitHub's markup for an uploaded video, as it appears in bodyHTML.
const VIDEO = `<details open="" class="details-reset border rounded-2"><summary class="px-3 py-2"><svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" class="octicon octicon-device-camera-video"><path d="M16 3.75v8.5a.75.75 0 0 1-1.136.643L11 10.575v.675A1.75 1.75 0 0 1 9.25 13h-7.5A1.75 1.75 0 0 1 0 11.25v-6.5C0 3.784.784 3 1.75 3h7.5c.966 0 1.75.784 1.75 1.75v.675l3.864-2.318A.75.75 0 0 1 16 3.75Z"></path></svg><span class="m-1">integration-browser.mp4</span><span class="dropdown-caret"></span></summary><video src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" controls="controls" muted="muted" class="d-block rounded-bottom-2 border-top width-fit" style="max-height:640px; min-height: 200px"></video></details>`;

function details(target: WorkItem): ItemDetails {
  const isPr = target.type === "pr";
  return {
    author: target.author ? person(target.author) : null,
    createdAt: ago(72),
    bodyHTML: `<h2>Summary</h2><p>Adds a searchable integration browser. Closes <code>#405</code>, see the recording:</p>${VIDEO}<h2>Notes</h2><pre><code>bun run dev -- --demo</code></pre><ul><li>Categories come from the manifest</li><li>Search is fuzzy</li></ul>`,
    labels: [{ name: "enhancement", color: "a2eeef" }, { name: "frontend", color: "1d76db" }],
    assignees: [me],
    comments: {
      total: earlierComments.length + (isPr ? 5 : 3),
      latest: [
        // Discussions have threads; this one has earlier replies to load.
        comment(alice, "<p>Looks great! One question about the empty state.</p>", 20, 1,
          target.type === "discussion" ? { total: threadReplies.length, latest: threadReplies.slice(-2), before: String(threadReplies.length - 2) } : null),
        comment(bob, `<p>Hey ${mention("octocat")}, the search box loses focus on Safari, see the issue. ${mention("defunkt")} saw it too.</p>`, 6, 2),
        // PR conversations include reviews, each with its inline comments.
        ...(isPr
          ? [
              review(alice, "CHANGES_REQUESTED", "<p>The empty state needs a call to action, and the search box should keep focus after filtering.</p>", 4, 1, [
                inline(alice, "<p>This should debounce, filtering on every keystroke re-renders the whole list.</p>", 4, 11,
                  "src/panels/config/integrations/integration-browser.ts", 11,
                  '@@ -0,0 +1,15 @@\n+  @state() private filter = "";\n+\n+  render() {\n+    return html`<input @input=${(e: InputEvent) => (this.filter = (e.target as HTMLInputElement).value)} />`;'),
                inline(alice, "<p>Can we keep the old export name for a release, so integrations importing it don't break?</p>", 4, 12,
                  "src/data/integrations.ts", 3, '@@ -1,3 +1,74 @@\n import { mdiPowerSocketEu } from "@mdi/js";\n \n-export const integrations = [];\n+export const integrations = ['),
              ]),
              review(bob, "APPROVED", "", 2, 2, []),
            ]
          : []),
        comment(me, '<p>Fixed in the latest push, thanks both. Rebased on <a href="https://github.com/acme/web/pull/398" data-hovercard-type="pull_request" data-hovercard-url="/acme/web/pull/398/hovercard">#398</a>, written as a Markdown link.</p>', 1, 3),
      ],
      before: String(earlierComments.length),
    },
    // Newest first, as the server sorts it.
    timeline: ([
      { kind: "commented", actor: me, createdAt: ago(1), detail: null, url: "https://github.com/acme/web/pull/412#issuecomment-3", excerpt: "Fixed in the latest push, thanks both." },
      ...commits.map((c, i): TimelineEvent => ({
        kind: "committed",
        actor: c.author ?? { login: c.authorName, avatarUrl: "", url: null },
        createdAt: c.authoredAt,
        detail: c.message.split("\n")[0]!,
        url: `https://github.com/acme/web/pull/412/commits/${c.sha}`,
        commit: { sha: c.sha, message: c.message, additions: [74, 12, 9, 4][i]!, deletions: [1, 2, 3, 24][i]!, changedFiles: [2, 2, 1, 2][i]!, checks: (["SUCCESS", "SUCCESS", "FAILURE", "PENDING"] as const)[i]! },
      })),
      { kind: "force_pushed", actor: me, createdAt: ago(2.5), detail: null, url: null, forcePush: { before: "9f1c2e7d4b".padEnd(40, "0"), after: commits[3]!.sha } },
      { kind: "reviewed", actor: alice, createdAt: ago(4), detail: "CHANGES_REQUESTED", url: "https://github.com/acme/web/pull/412#pullrequestreview-1", excerpt: "The empty state needs a call to action, and the search box should keep focus after filtering." },
      { kind: "commented", actor: bob, createdAt: ago(6), detail: null, url: "https://github.com/acme/web/pull/412#issuecomment-2", excerpt: "The search box loses focus on Safari, see the issue." },
      { kind: "review_requested", actor: me, createdAt: ago(10), detail: "hubot", url: null, subject: person("hubot") },
      {
        kind: "referenced",
        actor: bob,
        createdAt: ago(12),
        detail: "Integration list doesn't scroll on Safari",
        url: "https://github.com/acme/web/issues/405",
        source: { type: "issue", owner: "acme", repo: "web", number: 405, title: "Integration list doesn't scroll on Safari", url: "https://github.com/acme/web/issues/405", state: "OPEN", stateReason: null },
      },
      { kind: "commented", actor: alice, createdAt: ago(20), detail: null, url: "https://github.com/acme/web/pull/412#issuecomment-1", excerpt: "Looks great! One question about the empty state." },
      { kind: "renamed", actor: me, createdAt: ago(35), detail: "Add integration browser with search and categories", url: null, previousTitle: "Integration browser" },
      { kind: "labeled", actor: bob, createdAt: ago(40), detail: "frontend", url: null, label: { name: "frontend", color: "1d76db" } },
      { kind: "labeled", actor: bob, createdAt: ago(40.5), detail: "enhancement", url: null, label: { name: "enhancement", color: "a2eeef" } },
      { kind: "unlabeled", actor: alice, createdAt: ago(39), detail: "needs triage", url: null, label: { name: "needs triage", color: "d93f0b" } },
      { kind: "assigned", actor: me, createdAt: ago(41), detail: me.login, url: null, subject: me },
      { kind: "converted_to_draft", actor: me, createdAt: ago(60), detail: null, url: null },
      { kind: "ready_for_review", actor: me, createdAt: ago(45), detail: null, url: null },
    ] satisfies TimelineEvent[])
      // Commits, reviews and draft changes only happen on PRs.
      .filter((e) => isPr || !["committed", "force_pushed", "reviewed", "review_requested", "ready_for_review", "converted_to_draft"].includes(e.kind))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
    // #412 closes #405.
    linked: isPr
      ? [{ type: "issue", owner: "acme", repo: "web", number: 405, title: "Integration list doesn't scroll on Safari", url: "https://github.com/acme/web/issues/405", state: "OPEN", stateReason: null }]
      : target.number === 405
        ? [{ type: "pr", owner: "acme", repo: "web", number: 412, title: "Add integration browser with search and categories", url: "https://github.com/acme/web/pull/412", state: "OPEN", isDraft: false }]
        : [],
    involved: [me, alice, bob],
    // Mentioned in the body or comments; #405 is also the closing link, so Related shows it once.
    references: {
      "acme/web#398": { type: "pr", owner: "acme", repo: "web", number: 398, title: "Draft: migrate settings to the new form library", url: "https://github.com/acme/web/pull/398", state: "OPEN", isDraft: true, author: me, createdAt: ago(30), excerpt: "Moves the settings forms to the new form library." },
      "acme/web#405": { type: "issue", owner: "acme", repo: "web", number: 405, title: "Integration list doesn't scroll on Safari", url: "https://github.com/acme/web/issues/405", state: "OPEN", stateReason: null, author: bob, createdAt: ago(80), excerpt: "On Safari the integration list stops scrolling after a filter is applied." },
      "acme/design#12": { type: "discussion", owner: "acme", repo: "design", number: 12, title: "Icon set for integrations", url: "https://github.com/acme/design/discussions/12", closed: true, stateReason: "RESOLVED", author: alice, createdAt: ago(300), excerpt: "Which icon set should integrations use?" },
    },
    pr: isPr
      ? {
          baseRef: "dev",
          headRef: "integration-browser",
          additions: diffFiles.reduce((n, f) => n + f.additions, 0),
          deletions: diffFiles.reduce((n, f) => n + f.deletions, 0),
          changedFiles: diffFiles.length,
          commits: commits.length,
          files: diffFiles.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
          mergeable: "MERGEABLE",
          reviews: [{ author: alice, state: "CHANGES_REQUESTED" }, { author: bob, state: "APPROVED" }],
          requestedReviewers: ["hubot"],
          checks: [
            { name: "lint", status: "failure", url: null },
            { name: "test (ubuntu)", status: "success", url: null },
            { name: "build", status: "pending", url: null },
          ],
        }
      : null,
    discussion: target.type === "discussion" ? { answer: null } : null,
  };
}

const commits: Commit[] = [
  ["Scaffold integration browser", 50],
  ["Add category filter\n\nCategories come from the integration manifest, so new ones show up without a code change.", 30],
  ["Fuzzy search", 9],
  ["Fix focus loss on Safari", 2],
].map(([message, hours], i) => ({
  sha: `${i + 1}`.repeat(7) + "abcdef0123456789abcdef0123456789a".slice(0, 33),
  message: message as string,
  author: i === 2 ? null : me,
  authorName: i === 2 ? "Octo Cat" : me.login,
  authoredAt: ago(hours as number),
  url: `https://github.com/acme/web/commit/${i}`,
}));

// A unified diff file from a starting line and a list of lines prefixed "+", "-" or " ".
function file(path: string, status: DiffFile["status"], start: number, lines: string[] | null, previousPath: string | null = null): DiffFile {
  if (!lines) return { path, previousPath, status, additions: 0, deletions: 0, patch: null };
  const additions = lines.filter((l) => l.startsWith("+")).length;
  const deletions = lines.filter((l) => l.startsWith("-")).length;
  const header = `@@ -${start},${lines.length - additions} +${start},${lines.length - deletions} @@`;
  return { path, previousPath, status, additions, deletions, patch: [header, ...lines].join("\n") };
}

const integrations = Array.from({ length: 70 }, (_, i) => `+  { domain: "integration_${i}", name: "Integration ${i}", icon: mdiPowerSocketEu },`);
const diffFiles: DiffFile[] = [
  file("src/data/integrations.ts", "modified", 1, [" import { mdiPowerSocketEu } from \"@mdi/js\";", " ", "-export const integrations = [];", "+export const integrations = [", ...integrations, "+];"]),
  file("src/panels/config/integrations/integration-browser.ts", "added", 1, [
    "+import { LitElement, css, html } from \"lit\";",
    "+import { customElement, state } from \"lit/decorators.js\";",
    "+",
    "+/* Lists integrations by category,",
    "+   filtered by the search box. */",
    "+@customElement(\"integration-browser\")",
    "+export class IntegrationBrowser extends LitElement {",
    "+  @state() private filter = \"\";",
    "+",
    "+  render() {",
    "+    return html`<input @input=${(e: InputEvent) => (this.filter = (e.target as HTMLInputElement).value)} />`;",
    "+  }",
    "+",
    "+  static styles = css`:host { display: block; }`;",
    "+}",
  ]),
  file("src/components/ha-ripple.ts", "modified", 171, [
    "   }",
    " ",
    "-  private get _offset() {",
    "-    return this.offsetLeft;",
    "+  private get _offset(): number {",
    "+    // In RTL layouts the ripple starts from the right edge.",
    "+    return getComputedStyle(this).direction === \"rtl\" ? this.offsetWidth - this.offsetLeft : this.offsetLeft;",
    "   }",
    " ",
    "   render() {",
  ]),
  file("src/styles/integration-browser.css", "renamed", 3, [" .browser {", "-  gap: 8px;", "+  gap: var(--spacing-2);", "+  display: grid;", " }"], "src/styles/browser.css"),
  file("docs/integrations.md", "added", 1, ["+# Integrations", "+", "+Browse integrations by **category** or search by name.", "+", "+```sh", "+bun run dev", "+```"]),
  file("src/legacy/integration-list.ts", "removed", 1, Array.from({ length: 24 }, (_, i) => `-// legacy line ${i}`)),
  file("public/integration-placeholder.png", "added", 1, null),
];

function respond(path: string): unknown {
  const url = new URL(path, location.origin);
  const params = url.searchParams;
  const target = items.find((i) => i.repo === params.get("repo") && i.number === Number(params.get("number")));
  switch (url.pathname) {
    case "/api/me":
      return { login: me.login, avatarUrl: me.avatarUrl };
    case "/api/rate-limit":
      return { limit: 5000, remaining: 4321, resetAt: ago(-1) };
    case "/api/work":
      return work;
    case "/api/item":
      return target ? details(target) : null;
    case "/api/commits":
      return { commits, truncated: false };
    case "/api/diff": {
      // Each commit shows a slice of the PR's files.
      const index = commits.findIndex((c) => c.sha === params.get("sha"));
      return { files: index < 0 ? diffFiles : diffFiles.slice(index, index + 2), truncated: false } satisfies Diff;
    }
    case "/api/comments":
      return params.get("replyTo") ? page(threadReplies, params.get("before")!) : page(earlierComments, params.get("before")!);
    case "/api/profile":
      return { ...person(params.get("login") ?? "ghost"), name: null, bio: "Demo profile", location: null, url: "https://github.com", createdAt: ago(20_000) };
  }
  return undefined;
}

/** Answers an API request from the fixtures, like the server would. Reads get JSON (404 if unknown); writes succeed. */
export async function demoResponse(path: string, init?: RequestInit): Promise<Response> {
  // A little latency, so loading states show.
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (init?.method && init.method !== "GET") return new Response(null, { status: 204 });
  const body = respond(path);
  return body ? Response.json(body) : Response.json({ error: "Not in the demo data" }, { status: 404 });
}
