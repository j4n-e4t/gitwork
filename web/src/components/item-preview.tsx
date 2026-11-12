import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignLeft,
  ArrowUp,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  Eye,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Link2,
  ListTodo,
  MessageSquare,
  Pencil,
  SquareArrowOutUpRight,
  Tag,
  TriangleAlert,
  Upload,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { relativeTime, stateIcon } from "@/components/item-card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  UnauthorizedError,
  type CheckStatus,
  type ItemComment,
  type ItemDetails,
  itemKey,
  type LinkedItem,
  type Person,
  type TimelineEvent,
  type WorkItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  item: WorkItem | null;
  // The card's actions (watch, menu, check off), rendered in the header.
  actions: ReactNode;
  // The item's open todos from the dashboard, shown in their own tab.
  todoCount: number;
  todos: ReactNode;
  // Board items, so linked items that are on the board open in the preview instead of on GitHub.
  boardItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
  onClose: () => void;
  onSignedOut: () => void;
};

const CHECK_ICONS: Record<CheckStatus, [LucideIcon, string]> = {
  failure: [CircleX, "text-red-400"],
  pending: [CircleDot, "text-amber-400"],
  success: [CircleCheck, "text-emerald-400"],
  neutral: [CircleMinus, "text-muted-foreground"],
  skipped: [CircleDashed, "text-muted-foreground"],
};

const REVIEW_LABELS: Record<string, [string, string]> = {
  APPROVED: ["Approved", "text-emerald-400"],
  CHANGES_REQUESTED: ["Changes requested", "text-red-400"],
  COMMENTED: ["Commented", "text-muted-foreground"],
  DISMISSED: ["Dismissed", "text-muted-foreground"],
  PENDING: ["Pending", "text-muted-foreground"],
};

export function ItemPreview({ item, actions, todoCount, todos, boardItems, onOpenItem, onClose, onSignedOut }: Props) {
  // Details already fetched this session, so reopening an item is instant (and then refreshed).
  const cache = useRef(new Map<string, ItemDetails>());
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("description");
  // A comment picked in the timeline; scrolled to once the conversation tab has rendered it.
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollTarget) return;
    document.querySelector(`[data-comment-url="${CSS.escape(scrollTarget)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTarget(null);
  }, [scrollTarget]);

  const showComment = (url: string) => {
    setTab("conversation");
    setScrollTarget(url);
  };

  useEffect(() => {
    if (!item) return;
    let current = true;
    setDetails(cache.current.get(item.url) ?? null);
    setError(null);
    setTab("description");
    api.item(item).then(
      (next) => {
        cache.current.set(item.url, next);
        if (current) setDetails(next);
      },
      (e) => {
        if (e instanceof UnauthorizedError) onSignedOut();
        else if (current) setError((e as Error).message);
      },
    );
    return () => {
      current = false;
    };
  }, [item, onSignedOut]);

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {item && (
        <DialogContent showCloseButton={false} className="flex h-[85dvh] flex-col gap-0 p-0 sm:max-w-6xl">
          {/* The tab row lives in the header so it never scrolls; the root wraps both it and the content below. */}
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-h-0 flex-1 gap-0">
            <PreviewHeader item={item} details={details} actions={actions} todoCount={todoCount} />
            {/* Below md the sidebar stacks under the main column and both scroll together. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
              <div className="min-w-0 flex-1 space-y-6 p-4 md:overflow-y-auto">
                {error && (
                  <p role="alert" className="flex items-center gap-2 text-destructive">
                    <TriangleAlert className="size-4" /> {error}
                  </p>
                )}
                {/* Todos come from the dashboard, so they don't wait for the details. */}
                <TabsContent value="todos">{todos}</TabsContent>
                {tab !== "todos" && !details && !error && <LoadingBody />}
                {details && <PreviewBody item={item} details={details} boardItems={boardItems} onOpenItem={onOpenItem} />}
              </div>
              {details && (
                <aside className="space-y-6 border-t p-4 md:flex md:w-80 md:shrink-0 md:flex-col md:overflow-y-auto md:border-t-0 md:border-l">
                  <PreviewSidebar item={item} details={details} onShowComment={showComment} />
                </aside>
              )}
            </div>
          </Tabs>
        </DialogContent>
      )}
    </Dialog>
  );
}

function PreviewHeader({
  item,
  details,
  actions,
  todoCount,
}: {
  item: WorkItem;
  details: ItemDetails | null;
  actions: ReactNode;
  todoCount: number;
}) {
  const [StateIcon, stateClass, stateLabel] = stateIcon(item);
  return (
    <div className="space-y-1.5 border-b px-4 pt-3 pb-0.5">
      <div className="flex items-start gap-3">
        <DialogTitle className="min-w-0 flex-1 text-lg leading-snug [overflow-wrap:anywhere]">{item.title}</DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          <Button asChild variant="outline" size="sm" className="no-underline!">
            <a href={item.url} target="_blank" rel="noreferrer">
              <SquareArrowOutUpRight /> Open on GitHub
            </a>
          </Button>
          {actions}
          {/* In the row rather than the dialog's corner, so it lines up with the other buttons. */}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm">
              <X />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </div>
      </div>
      <DialogDescription asChild>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar className="size-5">
              <AvatarImage src={item.ownerAvatarUrl} alt="" />
              <AvatarFallback>{item.owner[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="truncate">
              {item.owner}/{item.repo}
            </span>
            <span className="shrink-0">#{item.number}</span>
          </span>
          <span className={cn("flex items-center gap-1.5", stateClass)}>
            <StateIcon className="size-4" /> {stateLabel}
          </span>
          {details?.author && (
            <span className="flex items-center gap-1.5">
              <PersonAvatar person={details.author} /> {details.author.login} opened {relativeTime(details.createdAt)} ago
            </span>
          )}
        </div>
      </DialogDescription>
      {/* The active tab's underline sits on the header's bottom border. */}
      <TabsList variant="line" className="mt-1">
        <TabsTrigger value="description">
          <AlignLeft /> Description
        </TabsTrigger>
        <TabsTrigger value="conversation">
          <MessageSquare /> Conversation {details && <span className="text-xs text-muted-foreground">{details.comments.total}</span>}
        </TabsTrigger>
        <TabsTrigger value="linked">
          <Link2 /> Linked {details && <span className="text-xs text-muted-foreground">{details.linked.length}</span>}
        </TabsTrigger>
        <TabsTrigger value="todos">
          <ListTodo /> Todos <span className="text-xs text-muted-foreground">{todoCount}</span>
        </TabsTrigger>
      </TabsList>
    </div>
  );
}

type Tab = "description" | "conversation" | "linked" | "todos";

// The conversation tab lists the latest comments newest first.
function PreviewBody({
  item,
  details,
  boardItems,
  onOpenItem,
}: {
  item: WorkItem;
  details: ItemDetails;
  boardItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
}) {
  const { total, latest } = details.comments;
  return (
    <>
      <TabsContent value="description">
        {details.bodyHTML ? <GitHubHtml html={details.bodyHTML} /> : <p className="text-muted-foreground">No description.</p>}
      </TabsContent>
      <TabsContent value="conversation" className="space-y-6">
        {/* The answer is usually older than the latest comments; when it's shown in the thread it's marked there instead. */}
        {details.discussion?.answer &&
          !latest.some((c) => c.isAnswer || c.replies?.latest.some((r) => r.isAnswer)) && (
          <Section title="Answer">
            <CommentView comment={details.discussion.answer} />
          </Section>
        )}
        {total === 0 ? (
          <p className="text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="space-y-3">
            {latest.toReversed().map((comment) => (
              <CommentView key={comment.url} comment={comment} />
            ))}
            {total > latest.length && (
              <a href={item.url} target="_blank" rel="noreferrer" className="inline-block text-muted-foreground hover:underline">
                Showing the latest {latest.length} · see all {total} comments on GitHub
              </a>
            )}
          </div>
        )}
      </TabsContent>
      <TabsContent value="linked">
        <LinkedItems item={item} linked={details.linked} boardItems={boardItems} onOpenItem={onOpenItem} />
      </TabsContent>
    </>
  );
}

function LinkedItems({
  item,
  linked,
  boardItems,
  onOpenItem,
}: {
  item: WorkItem;
  linked: LinkedItem[];
  boardItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
}) {
  if (linked.length === 0) {
    const none = { pr: "This PR doesn't close any issues.", issue: "No pull requests are linked to this issue.", discussion: "Discussions can't be linked to pull requests." };
    return <p className="text-muted-foreground">{none[item.type]}</p>;
  }
  return (
    <ul className="flex max-w-2xl flex-col gap-1.5">
      {linked.map((link) => {
        const onBoard = boardItems.find((i) => i.url === link.url);
        const [StateIcon, stateClass, stateLabel] = stateIcon(onBoard ?? link);
        const sameRepo = link.owner === item.owner && link.repo === item.repo;
        return (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                // Items on the board open in the preview; modified clicks and other items go to GitHub.
                if (!onBoard || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onOpenItem(onBoard);
              }}
              className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-3 py-2 hover:bg-muted"
            >
              <StateIcon className={cn("size-4 shrink-0", stateClass)} aria-label={stateLabel} />
              <span className="shrink-0 text-muted-foreground">{sameRepo ? `#${link.number}` : itemKey(link)}</span>
              <span className="truncate">{link.title}</span>
              {!onBoard && <SquareArrowOutUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-label="Opens on GitHub" />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function PreviewSidebar({ item, details, onShowComment }: { item: WorkItem; details: ItemDetails; onShowComment: (url: string) => void }) {
  return (
    <>
      {/* Keyed so the reviews and checks collapse again for each item. */}
      {details.pr && <PullRequestSummary key={item.url} pr={details.pr} />}
      {item.type === "discussion" && (
        <Section title="Discussion">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{item.category}</Badge>
            {item.isAnswered === true && <Badge variant="outline" className="text-emerald-400">Answered</Badge>}
            {item.isAnswered === false && <Badge variant="outline" className="text-amber-400">Unanswered</Badge>}
            <span className="text-muted-foreground">{item.upvotes} upvotes</span>
          </div>
        </Section>
      )}
      {details.labels.length > 0 && (
        <Section title="Labels">
          <div className="flex flex-wrap gap-1.5">
            {details.labels.map((label) => (
              <Badge key={label.name} variant="outline" className="gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                {label.name}
              </Badge>
            ))}
          </div>
        </Section>
      )}
      {details.assignees.length > 0 && (
        <Section title="Assignees">
          <PeopleList people={details.assignees} />
        </Section>
      )}
      <Timeline item={item} details={details} onShowComment={onShowComment} />
    </>
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
  APPROVED: ["approved", "text-emerald-400"],
  CHANGES_REQUESTED: ["requested changes", "text-red-400"],
  DISMISSED: ["review dismissed", "text-muted-foreground"],
  PENDING: ["started a review", "text-muted-foreground"],
};

// The verb shown after the actor, plus a secondary line for events whose detail is free text.
function describe(e: TimelineEvent): { verb: string; color?: string; secondary?: string } {
  switch (e.kind) {
    case "commented":
      return e.detail === "ANSWER" ? { verb: "answered", color: "text-emerald-400" } : { verb: "commented" };
    case "reviewed": {
      const [verb, color] = REVIEW_VERBS[e.detail ?? ""] ?? ["reviewed", undefined];
      return { verb, color };
    }
    case "committed":
      return { verb: "committed" };
    case "force_pushed":
      return { verb: "force-pushed" };
    case "merged":
      return { verb: "merged", color: "text-violet-400" };
    case "closed":
      if (e.detail === "NOT_PLANNED") return { verb: "closed as not planned", color: "text-muted-foreground" };
      if (e.detail === "DUPLICATE") return { verb: "closed as duplicate", color: "text-muted-foreground" };
      return { verb: "closed", color: "text-red-400" };
    case "reopened":
      return { verb: "reopened", color: "text-emerald-400" };
    case "labeled":
      return { verb: "added label", secondary: e.detail ?? undefined };
    case "unlabeled":
      return { verb: "removed label", secondary: e.detail ?? undefined };
    case "assigned":
      return { verb: `assigned ${e.detail ?? "someone"}` };
    case "review_requested":
      return { verb: `requested review from ${e.detail ?? "someone"}` };
    case "ready_for_review":
      return { verb: "marked ready for review" };
    case "converted_to_draft":
      return { verb: "converted to draft" };
    case "renamed":
      return { verb: "renamed to", secondary: e.detail ?? undefined };
    case "referenced":
      return { verb: "referenced in", secondary: e.detail ?? undefined };
  }
}

// The event icon with the actor's avatar as a badge in its corner.
function TimelineIcon({ icon: Icon, color, actor }: { icon: LucideIcon; color?: string; actor: Person | null }) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-md border bg-popover">
      <Icon className={cn("size-3.5 text-muted-foreground", color)} />
      {actor && (
        <Avatar className="absolute -right-1.5 -bottom-1.5 size-4 bg-popover ring-2 ring-popover" title={actor.login}>
          <AvatarImage src={actor.avatarUrl} alt="" />
          <AvatarFallback className="text-[0.5rem]">{actor.login[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
      )}
    </span>
  );
}

function Timeline({ item, details, onShowComment }: { item: WorkItem; details: ItemDetails; onShowComment: (url: string) => void }) {
  // Decided from the data rather than the DOM: the comment may be on the tab that isn't showing.
  const loadedComments = new Set(
    [...details.comments.latest, ...(details.discussion?.answer ? [details.discussion.answer] : [])].flatMap((c) => [
      c.url,
      ...(c.replies?.latest.map((r) => r.url) ?? []),
    ]),
  );
  return (
    // From md up the timeline takes the sidebar's remaining height and scrolls on its own; the rest stays put.
    <Section title="Timeline" className="md:flex md:min-h-0 md:flex-1 md:flex-col">
      <div className="pb-1 md:min-h-0 md:flex-1 md:overflow-y-auto">
        <ol className="relative space-y-1 before:absolute before:top-3 before:bottom-3 before:left-4 before:-translate-x-1/2 before:w-px before:bg-border">
          {details.timeline.map((e, i) => {
            const Icon = TIMELINE_ICONS[e.kind];
            const { verb, color, secondary } = describe(e);
            const row = (
              <>
                <TimelineIcon icon={Icon} color={color} actor={e.actor} />
                <span className="min-w-0 flex-1 space-y-0.5 pt-0.5">
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{e.actor?.login ?? "ghost"}</span>{" "}
                      <span className={cn("text-muted-foreground", color)}>{verb}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>
                      {relativeTime(e.createdAt)}
                    </span>
                  </span>
                  {secondary && <span className="block truncate text-xs text-muted-foreground">{secondary}</span>}
                </span>
              </>
            );
            const rowClass = "flex w-full items-start gap-2 rounded-md p-1 text-left";
            return (
              <li key={`${e.kind}-${e.createdAt}-${i}`}>
                {e.url ? (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(rowClass, "hover:bg-muted")}
                    // Comments loaded in the conversation tab are shown there instead of opened on GitHub.
                    onClick={(ev) => {
                      if (e.kind !== "commented" || !loadedComments.has(e.url!)) return;
                      ev.preventDefault();
                      onShowComment(e.url!);
                    }}
                  >
                    {row}
                  </a>
                ) : (
                  <div className={rowClass}>{row}</div>
                )}
              </li>
            );
          })}
          {details.author && (
            <li className="flex items-start gap-2 p-1">
              <TimelineIcon icon={CircleDot} actor={details.author} />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 pt-0.5">
                <span className="truncate">
                  <span className="font-medium">{details.author.login}</span> <span className="text-muted-foreground">opened</span>
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(details.createdAt)}</span>
              </span>
            </li>
          )}
        </ol>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" className="inline-block text-xs text-muted-foreground hover:underline">
        Full history on GitHub
      </a>
    </Section>
  );
}

function PullRequestSummary({ pr }: { pr: NonNullable<ItemDetails["pr"]> }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{pr.headRef}</span>
          <span className="text-muted-foreground">→</span>
          <span className="truncate">{pr.baseRef}</span>
        </span>
        <span className="text-xs">
          <span className="text-emerald-400">+{pr.additions}</span> <span className="text-red-400">−{pr.deletions}</span>{" "}
          <span className="text-muted-foreground">
            in {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          </span>
        </span>
        {pr.mergeable === "CONFLICTING" && (
          <Badge variant="outline" className="text-red-400">
            Merge conflicts
          </Badge>
        )}
      </div>
      <div className="space-y-2">
        <ReviewsSummary pr={pr} />
        {pr.checks.length > 0 && <ChecksSummary checks={pr.checks} />}
      </div>
    </>
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
  title: string;
  summary: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const row = (
    <>
      <Icon className={cn("size-4 shrink-0", iconColor)} />
      <span className="font-medium">{title}</span>
      {summary}
    </>
  );
  if (!children) return <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">{row}</div>;
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-muted"
      >
        {row}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted-foreground", expanded && "rotate-180")} />
      </button>
      {expanded && <ul className="max-h-56 space-y-1 overflow-y-auto border-t p-2">{children}</ul>}
    </div>
  );
}

function ReviewsSummary({ pr }: { pr: NonNullable<ItemDetails["pr"]> }) {
  const count = (state: string) => pr.reviews.filter((r) => r.state === state).length;
  const approved = count("APPROVED");
  const changes = count("CHANGES_REQUESTED");
  const requested = pr.requestedReviewers.length;
  const [icon, iconColor]: [LucideIcon, string] =
    changes > 0
      ? [CircleX, "text-red-400"]
      : approved > 0
        ? [CircleCheck, "text-emerald-400"]
        : requested > 0
          ? [CircleDot, "text-amber-400"]
          : [CircleDashed, "text-muted-foreground"];
  const hasRows = pr.reviews.length + requested > 0;
  return (
    <CollapsibleSummary
      icon={icon}
      iconColor={iconColor}
      title="Reviews"
      summary={
        hasRows ? (
          <>
            {approved > 0 && <span className="text-xs text-emerald-400">{approved} approved</span>}
            {changes > 0 && <span className="text-xs text-red-400">{changes} changes requested</span>}
            {requested > 0 && <span className="text-xs text-amber-400">{requested} requested</span>}
          </>
        ) : (
          <span className="text-muted-foreground">none yet</span>
        )
      }
    >
      {hasRows && (
        <>
          {pr.reviews.map((review, i) => {
            const [label, color] = REVIEW_LABELS[review.state] ?? [review.state, "text-muted-foreground"];
            return (
              <li key={review.author?.login ?? i} className="flex items-center gap-2 px-1 py-0.5">
                {review.author && <PersonAvatar person={review.author} />}
                <span className="truncate">{review.author?.login ?? "ghost"}</span>
                <span className={cn("shrink-0 text-xs", color)}>{label}</span>
              </li>
            );
          })}
          {pr.requestedReviewers.map((name) => (
            <li key={`requested-${name}`} className="flex items-center gap-2 px-1 py-0.5 text-muted-foreground">
              <CircleDot className="size-5 shrink-0 p-0.5 text-amber-400" />
              <span className="truncate">{name}</span> <span className="shrink-0 text-xs">review requested</span>
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
          <span className="text-muted-foreground">
            {count("success")}/{checks.length}
          </span>
          {failing > 0 && <span className="text-xs text-red-400">{failing} failing</span>}
          {running > 0 && <span className="text-xs text-amber-400">{running} running</span>}
        </>
      }
    >
      {checks.map((check, i) => {
        const [Icon, color] = CHECK_ICONS[check.status];
        const content = (
          <>
            <Icon className={cn("size-4 shrink-0", color)} aria-label={check.status} />
            <span className="truncate">{check.name}</span>
          </>
        );
        return (
          <li key={`${check.name}-${i}`}>
            {check.url ? (
              <a href={check.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                {content}
              </a>
            ) : (
              <span className="flex items-center gap-2 px-1 py-0.5">{content}</span>
            )}
          </li>
        );
      })}
    </CollapsibleSummary>
  );
}

function CommentView({ comment }: { comment: ItemComment }) {
  const replies = comment.replies;
  return (
    <div data-comment-url={comment.url} className={cn("scroll-mt-4 overflow-hidden rounded-lg border", comment.isAnswer && "border-emerald-400/40")}>
      <CommentHeader comment={comment} className="border-b px-3 py-2" />
      <div className="px-3 py-2">
        <GitHubHtml html={comment.bodyHTML} />
      </div>
      {replies && replies.total > 0 && (
        <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
          {replies.total > replies.latest.length && (
            <a href={comment.url} target="_blank" rel="noreferrer" className="block text-xs text-muted-foreground hover:underline">
              {replies.total - replies.latest.length} earlier {replies.total - replies.latest.length === 1 ? "reply" : "replies"} on GitHub
            </a>
          )}
          {replies.latest.map((reply) => (
            <div key={reply.url} data-comment-url={reply.url} className="scroll-mt-4 space-y-1 border-l-2 pl-3">
              <CommentHeader comment={reply} />
              <GitHubHtml html={reply.bodyHTML} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentHeader({ comment, className }: { comment: ItemComment; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      {comment.author && <PersonAvatar person={comment.author} />}
      <span className="font-medium text-foreground">{comment.author?.login ?? "ghost"}</span>
      <a href={comment.url} target="_blank" rel="noreferrer" className="hover:underline" title={new Date(comment.createdAt).toLocaleString()}>
        {relativeTime(comment.createdAt)} ago
      </a>
      {comment.isAnswer && (
        <Badge variant="outline" className="text-emerald-400">
          <CircleCheck /> Answer
        </Badge>
      )}
      {comment.upvotes !== null && comment.upvotes > 0 && (
        <span className="ml-auto flex items-center gap-1" title={`${comment.upvotes} upvote${comment.upvotes === 1 ? "" : "s"}`}>
          <ArrowUp className="size-3.5" /> {comment.upvotes}
        </span>
      )}
    </div>
  );
}

// GitHub renders and sanitizes bodyHTML server-side, so it's safe to inject. Links open in a new tab so the
// dialog (and the board behind it) stay put.
function GitHubHtml({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const a of ref.current?.querySelectorAll("a[href]") ?? []) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer");
    }
  }, [html]);
  return (
    <div
      ref={ref}
      className="prose prose-sm prose-invert max-w-none [overflow-wrap:anywhere] prose-pre:overflow-x-auto prose-img:inline prose-img:my-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Section({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function PersonAvatar({ person }: { person: Person }) {
  return (
    <Avatar className="size-5">
      <AvatarImage src={person.avatarUrl} alt="" />
      <AvatarFallback>{person.login[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function PeopleList({ people }: { people: Person[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {people.map((p) => (
        <span key={p.login} className="flex items-center gap-1.5">
          <PersonAvatar person={p} /> {p.login}
        </span>
      ))}
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="space-y-3" aria-label="Loading details">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
