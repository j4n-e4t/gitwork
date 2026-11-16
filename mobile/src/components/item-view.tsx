"use dom";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  ArrowUp,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  Eye,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  MessageSquare,
  MessageSquareCheck,
  MessageSquareX,
  MessagesSquare,
  Pencil,
  Tag,
  TriangleAlert,
  Upload,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { itemKey, referenceKey, type CheckStatus, type ItemComment, type ItemDetails, type ItemType, type Person, type TimelineEvent } from "../../../server/types.ts";
import type { ItemSummary } from "../lib/items";
import "./item-view.css";

// The item screen's content: the web preview (web/src/components/item-preview.tsx) laid out for a phone, with the
// sidebar's summary above the description and the timeline as its own tab. Runs in a web view, so GitHub's
// rendered HTML and the desktop styling carry over. Links go back to the app: items open in their own screen,
// everything else in the browser.
export default function ItemView({
  item,
  details,
  error,
  insets,
  openItem,
  openUrl,
}: {
  item: ItemSummary;
  details: ItemDetails | null;
  error: string | null;
  // The bars floating over the page, in points.
  insets: { top: number; bottom: number };
  openItem: (item: ItemSummary) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const [tab, setTab] = useState<Tab>("description");
  const [collapsedComments, setCollapsedComments] = useState<ReadonlySet<string>>(new Set());

  const toggleComment = (url: string) =>
    setCollapsedComments((prev) => {
      const next = new Set(prev);
      if (!next.delete(url)) next.add(url);
      return next;
    });

  const showComment = (url: string) => {
    const comments = [...(details?.comments.latest ?? []), ...(details?.discussion?.answer ? [details.discussion.answer] : [])];
    const parent = comments.find((c) => c.replies?.latest.some((r) => r.url === url));
    // Rendered right away, so the comment is on the page to scroll to.
    flushSync(() => {
      setCollapsedComments((prev) => new Set([...prev].filter((u) => u !== url && u !== parent?.url)));
      setTab("conversation");
    });
    document.querySelector(`[data-comment-url="${CSS.escape(url)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Every link in the page goes through the app; the web view itself never navigates.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest("a[href]");
    if (!a) return;
    e.preventDefault();
    void openUrl((a as HTMLAnchorElement).href);
  };

  const links = { openItem, openUrl };
  return (
    <div className="page" onClick={onClick} style={{ "--inset-top": `${insets.top}px`, "--inset-bottom": `${insets.bottom}px` } as CSSProperties}>
      <Header item={item} details={details} />
      <nav className="tabs" role="tablist">
        <TabButton tab="description" current={tab} onSelect={setTab} label="Description" />
        <TabButton tab="conversation" current={tab} onSelect={setTab} label="Conversation" count={details?.comments.total} />
        <TabButton tab="linked" current={tab} onSelect={setTab} label="Linked" count={details?.linked.length} />
        <TabButton tab="timeline" current={tab} onSelect={setTab} label="Timeline" />
      </nav>
      <main className="content">
        {error && (
          <p role="alert" className="alert">
            <TriangleAlert className="icon" /> {error}
          </p>
        )}
        {!details && !error && <Loading />}
        {details && tab === "description" && (
          <>
            <Summary item={item} details={details} />
            {details.bodyHTML ? (
              <GitHubHtml html={details.bodyHTML} references={details.references} links={links} />
            ) : (
              <p className="muted">No description.</p>
            )}
          </>
        )}
        {details && tab === "conversation" && (
          <Conversation item={item} details={details} collapsed={collapsedComments} onToggle={toggleComment} links={links} />
        )}
        {details && tab === "linked" && <LinkedItems item={item} linked={details.linked} openItem={openItem} />}
        {details && tab === "timeline" && <Timeline item={item} details={details} onShowComment={showComment} />}
      </main>
    </div>
  );
}

type Tab = "description" | "conversation" | "linked" | "timeline";
type Links = { openItem: (item: ItemSummary) => Promise<void>; openUrl: (url: string) => Promise<void> };

function TabButton({
  tab,
  current,
  onSelect,
  label,
  count,
}: {
  tab: Tab;
  current: Tab;
  onSelect: (tab: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button type="button" role="tab" aria-selected={tab === current} className="tab" onClick={() => onSelect(tab)}>
      {label} {count !== undefined && <span className="count">{count}</span>}
    </button>
  );
}

// Mirrors stateIcon in web/src/components/item-card.tsx. An unresolved reference has no state, so it gets the
// type's icon.
function stateIcon(item: ItemSummary): [LucideIcon, string, string] {
  if (item.type === "discussion") {
    if (!("closed" in item)) return [MessagesSquare, "muted", "Discussion"];
    if (item.closed) {
      if (item.stateReason === "RESOLVED") return [MessageSquareCheck, "purple", "Closed as resolved"];
      return [MessageSquareX, "muted", `Closed as ${item.stateReason === "DUPLICATE" ? "duplicate" : "outdated"}`];
    }
    return [MessagesSquare, "green", "Open discussion"];
  }
  if (!("state" in item)) return item.type === "issue" ? [CircleDot, "muted", "Issue"] : [GitPullRequest, "muted", "Pull request"];
  if (item.type === "issue") {
    if (item.state === "OPEN") return [CircleDot, "green", "Open issue"];
    if (item.stateReason === "NOT_PLANNED" || item.stateReason === "DUPLICATE") return [CircleSlash, "muted", "Closed as not planned"];
    return [CircleCheck, "purple", "Closed as completed"];
  }
  if (item.state === "MERGED") return [GitMerge, "purple", "Merged"];
  if (item.state === "CLOSED") return [GitPullRequestClosed, "red", "Closed"];
  if (item.isDraft) return [GitPullRequestDraft, "muted", "Draft"];
  return [GitPullRequest, "green", "Open"];
}

function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

function Header({ item, details }: { item: ItemSummary; details: ItemDetails | null }) {
  const [StateIcon, stateClass, stateLabel] = stateIcon(item);
  return (
    <header className="header">
      <h1 className="title">{item.title}</h1>
      <div className="meta">
        <span className="repo">
          {"ownerAvatarUrl" in item && <img className="avatar" src={item.ownerAvatarUrl} alt="" />}
          <span className="truncate">
            {item.owner}/{item.repo}
          </span>
          <span>#{item.number}</span>
        </span>
        <span className={`state ${stateClass}`}>
          <StateIcon className="icon" /> {stateLabel}
        </span>
        {details?.author && (
          <span className="opened">
            <UserLink user={details.author} /> opened {relativeTime(details.createdAt)} ago
          </span>
        )}
      </div>
    </header>
  );
}

type User = { login: string; avatarUrl?: string; url?: string | null };

// A user's avatar and name, linking to their profile. A null user is GitHub's deleted-account "ghost".
function UserLink({ user, pill = false, avatar = true }: { user: User | null; pill?: boolean; avatar?: boolean }) {
  if (!user) return <span className="user">ghost</span>;
  // Commit authors without a GitHub account have a git name but no profile.
  const url = user.url === undefined ? `https://github.com/${user.login}` : user.url;
  const content = (
    <>
      {avatar && <Avatar user={user} />}
      {user.login}
    </>
  );
  const className = `user${pill ? " chip" : ""}`;
  return url ? (
    <a href={url} className={className}>
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

function Avatar({ user }: { user: User }) {
  const src = user.avatarUrl ?? `https://github.com/${user.login.replace(/\[bot\]$/, "")}.png?size=40`;
  return <img className="avatar" src={src} alt="" />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  );
}

const CHECK_ICONS: Record<CheckStatus, [LucideIcon, string]> = {
  failure: [CircleX, "red"],
  pending: [CircleDot, "amber"],
  success: [CircleCheck, "green"],
  neutral: [CircleMinus, "muted"],
  skipped: [CircleDashed, "muted"],
};

const REVIEW_LABELS: Record<string, [string, string]> = {
  APPROVED: ["Approved", "green"],
  CHANGES_REQUESTED: ["Changes requested", "red"],
  COMMENTED: ["Commented", "muted"],
  DISMISSED: ["Dismissed", "muted"],
  PENDING: ["Pending", "muted"],
};

// The web preview's sidebar, minus the timeline: PR summary, discussion state, labels and assignees.
function Summary({ item, details }: { item: ItemSummary; details: ItemDetails }) {
  return (
    <>
      {details.pr && <PullRequestSummary url={item.url} pr={details.pr} />}
      {item.type === "discussion" && "category" in item && (
        <div className="badges">
          <span className="badge">{item.category}</span>
          {item.isAnswered === true && <span className="badge green">Answered</span>}
          {item.isAnswered === false && <span className="badge amber">Unanswered</span>}
          <span className="muted">{item.upvotes} upvotes</span>
        </div>
      )}
      {details.labels.length > 0 && (
        <div className="badges">
          {details.labels.toSorted((a, b) => a.name.length - b.name.length).map((label) => (
            <span key={label.name} className="chip label">
              <Tag className="icon" style={{ color: `#${label.color}` }} />
              {label.name}
            </span>
          ))}
        </div>
      )}
      {details.assignees.length > 0 && (
        <div className="badges">
          <span className="muted">Assigned to</span>
          {details.assignees.map((p) => (
            <UserLink key={p.login} user={p} />
          ))}
        </div>
      )}
    </>
  );
}

function PullRequestSummary({ url, pr }: { url: string; pr: NonNullable<ItemDetails["pr"]> }) {
  return (
    <div className="panel">
      <ChangesSummary url={url} pr={pr} />
      <ReviewsSummary pr={pr} />
      {pr.checks.length > 0 && <ChecksSummary checks={pr.checks} />}
    </div>
  );
}

// A one-line summary that expands to its list; without a list it's a plain row.
function CollapsibleSummary({
  icon: Icon,
  iconColor,
  title,
  summary,
  children,
}: {
  icon: LucideIcon;
  iconColor: string;
  title: ReactNode;
  summary: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const row = (
    <>
      <Icon className={`icon ${iconColor}`} />
      <span className="row-title">{title}</span>
      <span className="row-summary">{summary}</span>
    </>
  );
  if (!children) return <div className="row">{row}</div>;
  return (
    <div>
      <button type="button" className="row" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {row}
        <ChevronDown className={`icon muted chevron${expanded ? " open" : ""}`} />
      </button>
      {expanded && <ul className="row-list">{children}</ul>}
    </div>
  );
}

function ChangesSummary({ url, pr }: { url: string; pr: NonNullable<ItemDetails["pr"]> }) {
  const conflicting = pr.mergeable === "CONFLICTING";
  const more = pr.changedFiles - pr.files.length;
  return (
    <CollapsibleSummary
      icon={conflicting ? TriangleAlert : GitBranch}
      iconColor={conflicting ? "red" : "muted"}
      title={
        <span className="mono small">
          {pr.headRef} <span className="muted">→</span> {pr.baseRef}
        </span>
      }
      summary={
        <>
          <span className="green">+{pr.additions}</span>
          <span className="red">−{pr.deletions}</span>
        </>
      }
    >
      {conflicting && <li className="red">This branch has merge conflicts</li>}
      <li className="muted small">
        {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} changed
      </li>
      {pr.files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <li key={file.path} className="file small">
            <span className="mono truncate">
              <span className="muted">{file.path.slice(0, slash + 1)}</span>
              {file.path.slice(slash + 1)}
            </span>
            <span className="green">+{file.additions}</span>
            <span className="red">−{file.deletions}</span>
          </li>
        );
      })}
      {more > 0 && (
        <li>
          <a href={`${url}/files`} className="muted small">
            {more} more {more === 1 ? "file" : "files"} on GitHub
          </a>
        </li>
      )}
    </CollapsibleSummary>
  );
}

function ReviewsSummary({ pr }: { pr: NonNullable<ItemDetails["pr"]> }) {
  const count = (state: string) => pr.reviews.filter((r) => r.state === state).length;
  const approved = count("APPROVED");
  const changes = count("CHANGES_REQUESTED");
  const requested = pr.requestedReviewers.length;
  const [icon, iconColor]: [LucideIcon, string] =
    changes > 0 ? [CircleX, "red"] : approved > 0 ? [CircleCheck, "green"] : requested > 0 ? [Eye, "amber"] : [CircleDashed, "muted"];
  const hasRows = pr.reviews.length + requested > 0;
  return (
    <CollapsibleSummary
      icon={icon}
      iconColor={iconColor}
      title="Reviews"
      summary={
        hasRows ? (
          <>
            {approved > 0 && <span className="green">{approved} approved</span>}
            {changes > 0 && <span className="red">{changes} changes requested</span>}
            {requested > 0 && <span className="amber">{requested} requested</span>}
          </>
        ) : (
          <span className="muted">none yet</span>
        )
      }
    >
      {hasRows && (
        <>
          {pr.reviews.map((review, i) => {
            const [label, color] = REVIEW_LABELS[review.state] ?? [review.state, "muted"];
            return (
              <li key={review.author?.login ?? i} className="file">
                <UserLink user={review.author} />
                <span className={`small ${color}`}>{label}</span>
              </li>
            );
          })}
          {pr.requestedReviewers.map((name) => (
            <li key={`requested-${name}`} className="file muted">
              <Eye className="icon amber" />
              <span className="truncate">{name}</span> <span className="small">review requested</span>
            </li>
          ))}
        </>
      )}
    </CollapsibleSummary>
  );
}

function ChecksSummary({ checks }: { checks: NonNullable<ItemDetails["pr"]>["checks"] }) {
  const count = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
  // Checks are sorted failures first, so the first one carries the overall state.
  const [icon, iconColor] = CHECK_ICONS[checks[0]!.status];
  const failing = count("failure");
  const running = count("pending");
  return (
    <CollapsibleSummary
      icon={icon}
      iconColor={iconColor}
      title="Checks"
      summary={
        <>
          <span className="muted">
            {count("success")}/{checks.length}
          </span>
          {failing > 0 && <span className="red">{failing} failing</span>}
          {running > 0 && <span className="amber">{running} running</span>}
        </>
      }
    >
      {checks.map((check, i) => {
        const [Icon, color] = CHECK_ICONS[check.status];
        const content = (
          <>
            <Icon className={`icon ${color}`} aria-label={check.status} />
            <span className="truncate">{check.name}</span>
          </>
        );
        return (
          <li key={`${check.name}-${i}`}>
            {check.url ? (
              <a href={check.url} className="file plain">
                {content}
              </a>
            ) : (
              <span className="file">{content}</span>
            )}
          </li>
        );
      })}
    </CollapsibleSummary>
  );
}

// The latest comments, oldest at the top like a thread, joined by a line that shows between the cards.
function Conversation({
  item,
  details,
  collapsed,
  onToggle,
  links,
}: {
  item: ItemSummary;
  details: ItemDetails;
  collapsed: ReadonlySet<string>;
  onToggle: (url: string) => void;
  links: Links;
}) {
  const { total, latest } = details.comments;
  const commentView = (comment: ItemComment) => (
    <CommentView
      key={comment.url}
      comment={comment}
      references={details.references}
      collapsed={collapsed.has(comment.url)}
      onToggle={() => onToggle(comment.url)}
      links={links}
    />
  );
  return (
    <>
      {/* The answer is usually older than the latest comments; when it's shown in the thread it's marked there instead. */}
      {details.discussion?.answer && !latest.some((c) => c.isAnswer || c.replies?.latest.some((r) => r.isAnswer)) && (
        <Section title="Answer">{commentView(details.discussion.answer)}</Section>
      )}
      {total === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <>
          <div className="thread">{latest.toReversed().map(commentView)}</div>
          {total > latest.length && (
            <a href={item.url} className="muted more">
              Showing the latest {latest.length} · see all {total} comments on GitHub
            </a>
          )}
        </>
      )}
    </>
  );
}

function CommentView({
  comment,
  references,
  collapsed,
  onToggle,
  links,
}: {
  comment: ItemComment;
  references: ItemDetails["references"];
  collapsed: boolean;
  onToggle: () => void;
  links: Links;
}) {
  const replies = comment.replies;
  return (
    <div data-comment-url={comment.url} className={`comment${comment.isAnswer ? " answer" : ""}`}>
      <CommentHeader
        comment={comment}
        className={collapsed ? "" : "bordered"}
        toggle={
          <button type="button" className="toggle" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? "Expand comment" : "Collapse comment"}>
            <ChevronDown className={`icon${collapsed ? " closed" : ""}`} />
          </button>
        }
      />
      {!collapsed && (
        <div className="comment-body">
          <GitHubHtml html={comment.bodyHTML} references={references} links={links} />
        </div>
      )}
      {!collapsed && replies && replies.total > 0 && (
        <div className="replies">
          {replies.total > replies.latest.length && (
            <a href={comment.url} className="muted small">
              {replies.total - replies.latest.length} earlier {replies.total - replies.latest.length === 1 ? "reply" : "replies"} on GitHub
            </a>
          )}
          {replies.latest.map((reply) => (
            <div key={reply.url} data-comment-url={reply.url} className="reply">
              <CommentHeader comment={reply} />
              <GitHubHtml html={reply.bodyHTML} references={references} links={links} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentHeader({ comment, className = "", toggle }: { comment: ItemComment; className?: string; toggle?: ReactNode }) {
  return (
    <div className={`comment-header ${className}`}>
      {toggle}
      <UserLink user={comment.author} />
      <a href={comment.url} className="muted">
        {relativeTime(comment.createdAt)} ago
      </a>
      {comment.isAnswer && (
        <span className="badge green">
          <CircleCheck className="icon" /> Answer
        </span>
      )}
      {comment.upvotes !== null && comment.upvotes > 0 && (
        <span className="upvotes">
          <ArrowUp className="icon" /> {comment.upvotes}
        </span>
      )}
    </div>
  );
}

function LinkedItems({ item, linked, openItem }: { item: ItemSummary; linked: ItemDetails["linked"]; openItem: (item: ItemSummary) => Promise<void> }) {
  if (linked.length === 0) {
    const none = { pr: "This PR doesn't close any issues.", issue: "No pull requests are linked to this issue.", discussion: "Discussions can't be linked to pull requests." };
    return <p className="muted">{none[item.type]}</p>;
  }
  return (
    <ul className="linked">
      {linked.map((link) => {
        const [StateIcon, stateClass, stateLabel] = stateIcon(link);
        const sameRepo = link.owner === item.owner && link.repo === item.repo;
        return (
          <li key={link.url}>
            <button type="button" className="linked-row" onClick={() => void openItem(link)}>
              <StateIcon className={`icon ${stateClass}`} aria-label={stateLabel} />
              <span className="muted">{sameRepo ? `#${link.number}` : itemKey(link)}</span>
              <span className="truncate">{link.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const TIMELINE_ICONS: Record<TimelineEvent["kind"], LucideIcon> = {
  commented: MessageSquare,
  reviewed: Eye,
  committed: GitCommitHorizontal,
  force_pushed: Upload,
  merged: GitMerge,
  closed: CircleX,
  reopened: CircleDot,
  labeled: Tag,
  unlabeled: Tag,
  assigned: UserPlus,
  review_requested: Eye,
  ready_for_review: GitPullRequest,
  converted_to_draft: GitPullRequestDraft,
  renamed: Pencil,
  referenced: Link2,
};

const REVIEW_VERBS: Record<string, [string, string]> = {
  APPROVED: ["approved", "green"],
  CHANGES_REQUESTED: ["requested changes", "red"],
  DISMISSED: ["review dismissed", "muted"],
  PENDING: ["started a review", "muted"],
};

// Same wording as the web timeline.
function describe(e: TimelineEvent): { verb: string; color?: string } {
  switch (e.kind) {
    case "commented":
      return e.detail === "ANSWER" ? { verb: "answered", color: "green" } : { verb: "commented" };
    case "reviewed": {
      const [verb, color] = REVIEW_VERBS[e.detail ?? ""] ?? ["reviewed", undefined];
      return { verb, color };
    }
    case "committed":
      return { verb: "committed" };
    case "force_pushed":
      return { verb: "force-pushed" };
    case "merged":
      return { verb: "merged", color: "purple" };
    case "closed":
      if (e.detail === "NOT_PLANNED") return { verb: "closed as not planned", color: "muted" };
      if (e.detail === "DUPLICATE") return { verb: "closed as duplicate", color: "muted" };
      return { verb: "closed", color: "red" };
    case "reopened":
      return { verb: "reopened", color: "green" };
    case "labeled":
      return { verb: "added a label" };
    case "unlabeled":
      return { verb: "removed a label" };
    case "assigned":
      return { verb: "assigned someone" };
    case "review_requested":
      return { verb: "requested a review" };
    case "ready_for_review":
      return { verb: "marked ready for review" };
    case "converted_to_draft":
      return { verb: "converted to draft" };
    case "renamed":
      return { verb: "renamed" };
    case "referenced":
      return { verb: "referenced this" };
  }
}

// The event icon with the actor's avatar as a badge in its corner.
function TimelineIcon({ icon: Icon, color, actor }: { icon: LucideIcon; color?: string; actor: Person | null }) {
  return (
    <span className="timeline-icon">
      <Icon className={`icon ${color ?? "muted"}`} />
      {actor && <img className="timeline-avatar" src={actor.avatarUrl} alt="" />}
    </span>
  );
}

function Timeline({ item, details, onShowComment }: { item: ItemSummary; details: ItemDetails; onShowComment: (url: string) => void }) {
  const loadedComments = new Set(
    [...details.comments.latest, ...(details.discussion?.answer ? [details.discussion.answer] : [])].flatMap((c) => [
      c.url,
      ...(c.replies?.latest.map((r) => r.url) ?? []),
    ]),
  );
  return (
    <>
      <ol className="timeline">
        {details.timeline.map((e, i) => {
          const { verb, color } = describe(e);
          const row = (
            <>
              <TimelineIcon icon={TIMELINE_ICONS[e.kind]} color={color} actor={e.actor} />
              <span className="timeline-text">
                <span className="truncate">
                  <span className="user">{e.actor?.login ?? "ghost"}</span> <span className={color ?? "muted"}>{verb}</span>
                </span>
                <span className="muted small">{relativeTime(e.createdAt)}</span>
              </span>
            </>
          );
          return (
            <li key={`${e.kind}-${e.createdAt}-${i}`}>
              {e.url ? (
                <a
                  href={e.url}
                  className="timeline-row"
                  // Comments loaded in the conversation tab are shown there instead of opened on GitHub.
                  onClick={(ev) => {
                    if (e.kind !== "commented" || !loadedComments.has(e.url!)) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    onShowComment(e.url!);
                  }}
                >
                  {row}
                </a>
              ) : (
                <div className="timeline-row">{row}</div>
              )}
            </li>
          );
        })}
        {details.author && (
          <li>
            <div className="timeline-row">
              <TimelineIcon icon={CircleDot} actor={details.author} />
              <span className="timeline-text">
                <span className="truncate">
                  <span className="user">{details.author.login}</span> <span className="muted">opened</span>
                </span>
                <span className="muted small">{relativeTime(details.createdAt)}</span>
              </span>
            </div>
          </li>
        )}
      </ol>
      <a href={item.url} className="muted small more">
        Full history on GitHub
      </a>
    </>
  );
}

type Reference = { kind: "user" | "issue" | "pull_request" | "discussion"; text: string; href: string; key: string | null; slot: HTMLElement };

const REFERENCE_ICONS: Record<Exclude<Reference["kind"], "user">, LucideIcon> = {
  issue: CircleDot,
  pull_request: GitPullRequest,
  discussion: MessagesSquare,
};

const REFERENCE_TYPES: Record<Exclude<Reference["kind"], "user">, ItemType> = { issue: "issue", pull_request: "pr", discussion: "discussion" };

// GitHub renders and sanitizes bodyHTML server-side, so it's safe to inject. As on the web, mentions and
// issue/PR/discussion links become chips colored by the referenced item's state, and top-level headings collapse
// their section. Phones have no hover, so the heading toggles are always shown.
function GitHubHtml({ html, references: resolved, links }: { html: string; references: ItemDetails["references"]; links: Links }) {
  const ref = useRef<HTMLDivElement>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<Element>>(new Set());
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const kind = a.classList.contains("user-mention") ? "user" : a.classList.contains("issue-link") ? a.dataset.hovercardType : undefined;
      if (kind !== "user" && kind !== "issue" && kind !== "pull_request" && kind !== "discussion") continue;
      const slot = document.createElement("span");
      Object.assign(slot.dataset, { reference: kind, text: (a.textContent ?? "").replace(/^@/, ""), href: a.href, url: a.dataset.url ?? a.href });
      a.replaceWith(slot);
    }
    setReferences(
      [...root.querySelectorAll<HTMLElement>("span[data-reference]")].map((slot) => {
        const kind = slot.dataset.reference as Reference["kind"];
        return { kind, text: slot.dataset.text!, href: slot.dataset.href!, key: kind === "user" ? null : referenceKey(slot.dataset.url!), slot };
      }),
    );
    setHeadings(findHeadings(root));
    setCollapsed(new Set());
  }, [html]);

  // A collapsed heading hides everything after it up to the next heading of the same or a higher level.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const byBlock = new Map(headings.map((h) => [h.block, h]));
    const open: { level: number; collapsed: boolean }[] = [];
    for (const child of root.children) {
      const heading = byBlock.get(child);
      if (heading) while (open.length > 0 && open.at(-1)!.level >= heading.level) open.pop();
      child.toggleAttribute("hidden", open.some((h) => h.collapsed));
      if (heading) open.push({ level: heading.level, collapsed: collapsed.has(child) });
    }
  }, [headings, collapsed]);

  const toggle = (block: Element) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  return (
    <>
      <div
        ref={ref}
        className="markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const target = e.target as Element;
          const heading = headings.find((h) => h.block.contains(target));
          if (heading && !target.closest("a")) toggle(heading.block);
        }}
      />
      {references.map((reference, i) => createPortal(<ReferenceChip reference={reference} resolved={resolved} links={links} />, reference.slot, i))}
      {headings.map((heading, i) =>
        createPortal(
          <span className={`heading-toggle${collapsed.has(heading.block) ? " closed" : ""}`} aria-hidden>
            <ChevronDown className="icon" />
          </span>,
          heading.slot,
          `heading-${i}`,
        ),
      )}
    </>
  );
}

type Heading = { level: number; block: Element; slot: HTMLElement };

// Top-level headings, bare or in GitHub's `<div class="markdown-heading">` wrapper, each given a slot for the toggle.
function findHeadings(root: Element): Heading[] {
  const headings: Heading[] = [];
  for (const block of root.children) {
    const h = block.matches("h1, h2, h3, h4, h5, h6") ? block : block.matches(".markdown-heading") ? block.querySelector("h1, h2, h3, h4, h5, h6") : null;
    if (!h) continue;
    let slot = h.querySelector<HTMLElement>(":scope > [data-heading-toggle]");
    if (!slot) {
      slot = document.createElement("span");
      slot.dataset.headingToggle = "";
      h.append(slot);
    }
    headings.push({ level: Number(h.tagName[1]), block, slot });
  }
  return headings;
}

// An issue, PR or discussion chip. Tapping it opens the item in the app, resolved or not: the link says enough to
// fetch it.
function ReferenceChip({ reference: { kind, text, href, key }, resolved, links }: { reference: Reference; resolved: ItemDetails["references"]; links: Links }) {
  if (kind === "user") return <UserLink user={{ login: text, url: href }} pill />;
  const item = key ? resolved[key] : undefined;
  const [Icon, color, label] = item ? stateIcon(item) : [REFERENCE_ICONS[kind], "muted", undefined];
  const target = item ?? fromUrl(kind, href, text);
  return (
    <a
      href={href}
      className="chip reference"
      onClick={(e) => {
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        void links.openItem(target);
      }}
    >
      <Icon className={`icon ${color}`} aria-label={label} />
      {text}
    </a>
  );
}

function fromUrl(kind: Exclude<Reference["kind"], "user">, href: string, text: string): ItemSummary | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull|discussions)\/(\d+)/.exec(href);
  if (!m) return null;
  return { type: REFERENCE_TYPES[kind], owner: m[1]!, repo: m[2]!, number: Number(m[3]), title: text, url: href };
}

function Loading() {
  return (
    <div className="loading" aria-label="Loading details">
      <div className="skeleton" style={{ width: "33%" }} />
      <div className="skeleton" />
      <div className="skeleton" style={{ width: "83%" }} />
      <div className="skeleton tall" />
    </div>
  );
}
