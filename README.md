<img src="assets/icon.svg" width="64" height="64" alt="">

# gitwork

A dark-mode kanban board of the GitHub pull requests, issues and discussions you're involved in, plus ones you've bookmarked ("watching"). A switch at the top left flips between the three. Watching is a local bookmark list stored in SQLite. It is unrelated to GitHub's watch feature.

There is one column per reason. A PR that matches several reasons appears in each matching column:

- **Automatic:** open PRs and issues you authored, are assigned to, or are mentioned in, open issues you commented on, plus PRs with a review request for you. Discussions you started or commented in, including closed ones so you can see how they ended (resolved, outdated, answered).
- **Watching:** any PR, issue or discussion you bookmark, in any state.
- **Checking off:** merged and closed items never disappear on their own. Items that involved you while open stay in their columns after they merge or close, with a "Check off" button; checked-off items are hidden (Settings → "Show checked-off items" brings them back) and return if reopened.
- **Todos** (optional, turn on under Settings → Features): tasks with an optional deadline, optionally linked to an item on the board ("Add todo" in a card's menu). Grouped into Overdue, Today, Upcoming, No deadline and Done.
- **AI summaries** (optional, turn on under Settings → Features): a Summary tab in the item preview that writes a short overview of the item (what, who, why, related items, status) from its description, conversation and metadata with Gemini, on request.

Everything is fetched in one GitHub GraphQL request each time the page loads or you click Refresh, plus follow-up requests for any search with more than 50 results (up to 200 per search; a column count ending in "+" means GitHub has more). The account menu shows how much of your GitHub API rate limit is left.

From a card's menu you can hide that item, its repo, or everything from its owner. The **Hidden** menu lists what you've hidden, unhides items, and can show hidden items dimmed. Drag a column header (or use its menu) to reorder columns.

Stack: a Cloudflare Worker with one SQLite-backed Durable Object holding all data (`server/`), React + Vite + Tailwind + shadcn/ui + lucide icons (`web/`), served by Workers Assets.

## Configuration

You sign in with GitHub, and the app reads everything with your own GitHub token. Create a GitHub OAuth app at <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**:

- **Homepage URL:** where the app runs, `https://gitwork.jslop.fun` (or `http://localhost:5173` for local dev)
- **Authorization callback URL:** that same origin plus `/auth/callback`

Locally, put these in `.env` (copy `.env.example`); Wrangler loads it and it's git-ignored. In production, set them as Worker secrets (see Deploy).

| Variable               | Required | Default              | Notes                                                                                     |
| ---------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | yes      |                      | From the OAuth app.                                                                       |
| `GITHUB_CLIENT_SECRET` | yes      |                      | From the OAuth app.                                                                       |
| `ALLOWED_USERS`        | yes      |                      | Comma-separated GitHub logins allowed to sign in. Bookmarks and hidden items are shared. |
| `APP_URL`              | no       | the request's origin | Public origin. Set to `https://gitwork.jslop.fun` in `wrangler.jsonc`; `.env` overrides it locally. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | for AI summaries |  | Google AI Studio key for the optional AI summaries. The item's full text and metadata are sent to Google, so use a billed project (free-tier prompts may be used for training). |
| `GEMINI_MODEL`         | no       | `gemini-3.5-flash-lite` | Gemini model id, set in `wrangler.jsonc`.                                         |

The app requests the `repo` scope so it can read private repositories, plus `read:discussion` for discussion categories. Organizations with OAuth app access restrictions must approve the app before their private repos show up. Sessions last 30 days. Your GitHub token stays in the Durable Object's storage; the browser only gets an opaque HTTP-only session cookie.

## Run locally

```sh
bun install
cp .env.example .env   # then fill it in
bun run dev
```

This starts the Worker with `wrangler dev` on `:8787` and Vite on `:5173` (which proxies `/api` and `/auth`, so register `http://localhost:5173/auth/callback` on a dev OAuth app). Open http://localhost:5173. Local data lives in `.wrangler/state`.

Run `bun run types` after changing `wrangler.jsonc` or the variables in `.env` to regenerate `worker-configuration.d.ts`. Add shadcn components with `bunx shadcn@latest add <name>`.

## Deploy

```sh
bunx wrangler login
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put ALLOWED_USERS
bunx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
bun run deploy           # vite build && wrangler deploy
```

The app is served at <https://gitwork.jslop.fun> (a custom domain set under `routes` in `wrangler.jsonc`; the `jslop.fun` zone must be on the same Cloudflare account). The production OAuth app's callback URL is `https://gitwork.jslop.fun/auth/callback`. Cookies are marked `Secure` on `https` origins.

## Bookmarking

Paste a PR, issue or discussion URL, or `owner/repo#123`, into the box, or click the star on any card. Bookmarks that GitHub can't resolve (deleted, a number that's an issue rather than a PR, or no access) are shown with a "Not found" note so you can remove them. Organization discussion URLs (`github.com/orgs/…/discussions/N`) don't name the repo, so bookmark those with the star or as `owner/repo#N`.
