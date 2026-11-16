import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft,
  ArrowUp,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  Copy,
  Eye,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Link2,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Sparkles,
  SquareArrowOutUpRight,
  Tag,
  TriangleAlert,
  Upload,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { checksIcon, copyLink, relativeTime, stateIcon } from "@/components/item-card";
import { CommitDiff, FilesTab, forgetChanges } from "@/components/pr-changes";
import { UserLink, UserStack } from "@/components/user-link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  UnauthorizedError,
  type CheckStatus,
  type ItemComment,
  type ItemDetails,
  type ItemSummary,
  itemKey,
  type LinkedItem,
  sameItem,
  type Person,
  referenceKey,
  referenceLinkKind,
  type ReferencedItem,
  type TimelineEvent,
  type WorkItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  item: WorkItem | null;
  // The card's actions (watch, menu, check off), rendered in the header.
  actions: ReactNode;
  // Optional feature from Settings; its tab is only shown when it's on.
  summaryEnabled: boolean;
  // Board items, so linked items that are on the board open in the preview instead of on GitHub.
  boardItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
  onClose: () => void;
  // Shown as a full page instead of a dialog; the toggle is in the header.
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  // Feature flag (Settings → Experimental): the Files changed tab and commit diffs from History.
  diffs: boolean;
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

export function ItemPreview({ item, actions, summaryEnabled, boardItems, onOpenItem, onClose, fullscreen, onToggleFullscreen, diffs, onSignedOut }: Props) {
  // Details already fetched this session. Reopening an item shows these without asking GitHub again; the refresh
  // button re-fetches just this item.
  const cache = useRef(new Map<string, ItemDetails>());
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  // URLs being fetched, so the spinner belongs to the item on screen even after switching between items.
  const [fetching, setFetching] = useState<string[]>([]);
  const refreshing = item !== null && fetching.includes(item.url);
  // The item on screen, so a response for one that has since been replaced is only cached, not shown.
  const shownUrl = useRef<string | null>(null);
  shownUrl.current = item?.url ?? null;

  const fetchDetails = useCallback(
    (target: WorkItem) => {
      setError(null);
      setFetching((f) => [...f, target.url]);
      api
        .item(target)
        .then(
          (next) => {
            cache.current.set(target.url, next);
            if (shownUrl.current === target.url) setDetails(next);
          },
          (e) => {
            if (e instanceof UnauthorizedError) onSignedOut();
            else if (shownUrl.current === target.url) setError((e as Error).message);
          },
        )
        .finally(() => setFetching((f) => f.filter((url) => url !== target.url)));
    },
    [onSignedOut],
  );
  const [tab, setTab] = useState<Tab>("description");
  // Bumped by the refresh button so commit diffs and the Files changed tab re-fetch too.
  const [changesGeneration, setChangesGeneration] = useState(0);
  // These tabs lay out their own scrolling panes (a diff's file list and diffs), so the column around them stays put.
  const wide = tab === "history" || tab === "files";
  // A comment picked in the timeline; scrolled to once the conversation tab has rendered it.
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollTarget) return;
    document.querySelector(`[data-comment-url="${CSS.escape(scrollTarget)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTarget(null);
  }, [scrollTarget]);

  // Collapsed comments by URL, kept for the session like the details cache.
  const [collapsedComments, setCollapsedComments] = useState<ReadonlySet<string>>(new Set());
  const toggleComment = (url: string) =>
    setCollapsedComments((prev) => {
      const next = new Set(prev);
      if (!next.delete(url)) next.add(url);
      return next;
    });

  const showComment = (url: string) => {
    // Expand the comment, or the comment a reply belongs to, so there's something to scroll to.
    const comments = [...(details?.comments.latest ?? []), ...(details?.discussion?.answer ? [details.discussion.answer] : [])];
    const parent = comments.find((c) => c.replies?.latest.some((r) => r.url === url));
    setCollapsedComments((prev) => new Set([...prev].filter((u) => u !== url && u !== parent?.url)));
    setTab("conversation");
    setScrollTarget(url);
  };

  useEffect(() => {
    if (!item) return;
    const cached = cache.current.get(item.url);
    setDetails(cached ?? null);
    setError(null);
    setTab("description");
    if (!cached) fetchDetails(item);
  }, [item, fetchDetails]);

  // BoardContext wraps everything, so links anywhere in the preview (bodies, sidebar, history) open board items here.
  const content = item && (
        <BoardContext value={{ boardItems, onOpenItem }}>
          {/* The tab row lives in the header so it never scrolls; the root wraps both it and the content below. */}
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-h-0 flex-1 gap-0">
            <PreviewHeader
              item={item}
              details={details}
              actions={actions}
              summaryEnabled={summaryEnabled}
              refreshing={refreshing}
              fullscreen={fullscreen}
              onToggleFullscreen={onToggleFullscreen}
              onClose={onClose}
              diffs={diffs}
              onRefresh={() => {
                fetchDetails(item);
                forgetChanges(item);
                setChangesGeneration((g) => g + 1);
              }}
            />
            {/* Below md the sidebar stacks under the main column and both scroll together. The content sits on the darker
                background so its cards (comments, diffs) stand out; the sidebar keeps the dialog's panel color. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background md:flex-row md:overflow-hidden">
              {/* On the Commits and Files changed tabs the column itself stays put and the tab lays out its own scrolling panes. */}
              <div className={cn("min-w-0 flex-1", wide ? "flex min-h-0 flex-col overflow-clip" : "space-y-6 p-4 md:overflow-y-auto")}>
                {error && !wide && (
                  <p role="alert" className="flex items-center gap-2 text-destructive">
                    <TriangleAlert className="size-4" /> {error}
                  </p>
                )}
                {/* Keyed so each item starts from its own cached summary. Doesn't wait for the details; they only add
                    states and hover cards to its references. */}
                {summaryEnabled && (
                  <TabsContent value="summary">
                    <BoardContext value={{ boardItems, onOpenItem }}>
                      <SummaryView key={item.url} item={item} references={details?.references ?? {}} onSignedOut={onSignedOut} />
                    </BoardContext>
                  </TabsContent>
                )}
                <TabsContent value="history" className="min-h-0">
                  {details ? (
                    <HistoryTab item={item} details={details} diffs={diffs} generation={changesGeneration} onSignedOut={onSignedOut} onShowComment={showComment} />
                  ) : (
                    !error && <div className="p-4"><LoadingBody /></div>
                  )}
                </TabsContent>
                {/* Fetches on its own when opened, so it doesn't wait for the details either. */}
                {item.type === "pr" && diffs && (
                  <TabsContent value="files" className="min-h-0">
                    <FilesTab pr={item} generation={changesGeneration} onSignedOut={onSignedOut} />
                  </TabsContent>
                )}
                {tab !== "summary" && !wide && !details && !error && <LoadingBody />}
                {details && (
                  <PreviewBody
                    item={item}
                    details={details}
                    collapsedComments={collapsedComments}
                    onToggleComment={toggleComment}
                    onSignedOut={onSignedOut}
                  />
                )}
              </div>
              {details && (
                // Below md the sidebar stacks under the content; the diff tabs fill the height there, so it's left out.
                <aside
                  className={cn(
                    // Sections keep their height (*:shrink-0) and the sidebar scrolls when they don't fit.
                    "space-y-6 border-t bg-popover p-4 [view-transition-name:item-preview-sidebar] md:flex md:w-80 md:shrink-0 md:flex-col md:overflow-y-auto md:border-t-0 md:border-l md:*:shrink-0",
                    wide && "hidden",
                  )}
                >
                  <PreviewSidebar item={item} details={details} onShowComment={showComment} onViewAll={() => setTab("history")} />
                </aside>
              )}
            </div>
          </Tabs>
        </BoardContext>
  );

  // Full page: ordinary page content in place of the board (App hides it), so there's no overlay, focus trap or
  // Escape-to-close. It shares a view-transition-name with the dialog, so switching between the two morphs one into
  // the other (see App's toggle and index.css).
  if (fullscreen && item) {
    return <div className="flex min-h-0 flex-1 flex-col bg-popover text-sm [view-transition-name:item-preview]">{content}</div>;
  }
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {item && (
        <DialogContent showCloseButton={false} className="flex h-[85dvh] flex-col gap-0 p-0 [view-transition-name:item-preview] sm:max-w-6xl">
          {content}
        </DialogContent>
      )}
    </Dialog>
  );
}

function PreviewHeader({
  item,
  details,
  actions,
  summaryEnabled,
  refreshing,
  fullscreen,
  onToggleFullscreen,
  onClose,
  diffs,
  onRefresh,
}: {
  item: WorkItem;
  details: ItemDetails | null;
  actions: ReactNode;
  summaryEnabled: boolean;
  refreshing: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
  diffs: boolean;
  onRefresh: () => void;
}) {
  const [StateIcon, stateClass, stateLabel] = stateIcon(item);
  // Radix's title and description need a dialog around them; the full page uses plain elements styled the same.
  const Title = fullscreen ? "h2" : DialogTitle;
  const meta = (
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
          <UserLink user={details.author} /> opened {relativeTime(details.createdAt)} ago
        </span>
      )}
    </div>
  );
  return (
    <div className="space-y-1.5 border-b px-4 pt-3 pb-0.5">
      <div className="flex items-start gap-3">
        <Title className="min-w-0 flex-1 font-heading text-lg leading-snug font-medium [overflow-wrap:anywhere]">{item.title}</Title>
        {/* Named for the dialog/full-page view transition, so the buttons slide to their new place as one piece. */}
        <div className="flex shrink-0 items-center gap-1 [view-transition-name:item-preview-actions]">
          <Button asChild variant="outline" size="sm" className="no-underline!">
            <a href={item.url} target="_blank" rel="noreferrer">
              <SquareArrowOutUpRight /> Open on GitHub
            </a>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => copyLink(item.url)} aria-label="Copy link" title="Copy link">
            <Copy />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={refreshing} aria-label="Refresh this item" title="Refresh this item">
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
          {actions}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleFullscreen}
            aria-label={fullscreen ? "Show as dialog" : "Open as full page"}
            title={fullscreen ? "Show as dialog" : "Open as full page"}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
          {/* In the row rather than the dialog's corner, so it lines up with the other buttons. */}
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </div>
      {fullscreen ? meta : <DialogDescription asChild>{meta}</DialogDescription>}
      {/* The active tab's underline sits on the header's bottom border. */}
      <div className="mt-1 flex items-center gap-3">
        <TabsList variant="line">
          {summaryEnabled && (
            <TabsTrigger value="summary">
              <RainbowSparkles /> Summary
            </TabsTrigger>
          )}
          <TabsTrigger value="description">
            <AlignLeft /> Description
          </TabsTrigger>
          <TabsTrigger value="conversation">
            <MessageSquare /> Conversation {details && <span className="text-xs text-muted-foreground">{details.comments.total}</span>}
          </TabsTrigger>
          <TabsTrigger value="history">
            <History /> History
          </TabsTrigger>
          {item.type === "pr" && diffs && (
            <TabsTrigger value="files">
              <FileDiff /> Files changed {details?.pr && <span className="text-xs text-muted-foreground">{details.pr.changedFiles}</span>}
            </TabsTrigger>
          )}
        </TabsList>
        {details && details.involved.length > 0 && <UserStack users={details.involved} className="ml-auto hidden [view-transition-name:item-preview-people] sm:flex" />}
      </div>
    </div>
  );
}

type Tab = "summary" | "description" | "conversation" | "history" | "files";

// The conversation tab lists the latest comments newest first.
function PreviewBody({
  item,
  details,
  collapsedComments,
  onToggleComment,
  onSignedOut,
}: {
  item: WorkItem;
  details: ItemDetails;
  collapsedComments: ReadonlySet<string>;
  onToggleComment: (url: string) => void;
  onSignedOut: () => void;
}) {
  const { total, latest } = details.comments;
  const earlier = useEarlierComments(item, details.comments.before, onSignedOut);
  // Oldest first: the loaded earlier pages, then the latest ones that came with the details.
  const comments = [...earlier.comments, ...latest];
  const references = { ...details.references, ...earlier.references };
  const commentView = (comment: ItemComment) => (
    <CommentView
      key={comment.url}
      item={item}
      comment={comment}
      references={references}
      collapsed={collapsedComments.has(comment.url)}
      onToggle={() => onToggleComment(comment.url)}
      onSignedOut={onSignedOut}
    />
  );
  return (
    <>
      <TabsContent value="description">
        {details.bodyHTML ? <GitHubHtml html={details.bodyHTML} references={details.references} /> : <p className="text-muted-foreground">No description.</p>}
      </TabsContent>
      <TabsContent value="conversation" className="space-y-6">
        {/* The answer is usually older than the latest comments; when it's shown in the thread it's marked there instead. */}
        {details.discussion?.answer &&
          !comments.some((c) => c.isAnswer || c.replies?.latest.some((r) => r.isAnswer)) && (
          <Section title="Answer">
            {commentView(details.discussion.answer)}
          </Section>
        )}
        {total === 0 ? (
          <p className="text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="space-y-3">
            {/* A thread line, like GitHub's, runs under the opaque cards so it only shows in the gaps between them. */}
            <div className="relative space-y-4 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-border">
              {comments.toReversed().map(commentView)}
            </div>
            {/* Newest first, so earlier comments load at the bottom. */}
            <LoadEarlier earlier={earlier} remaining={total - comments.length} noun="comments" />
          </div>
        )}
      </TabsContent>
    </>
  );
}

type Earlier = ReturnType<typeof useEarlierComments>;

// Earlier comments, or with `replyTo` (a discussion comment's id) earlier replies in that thread, loaded a page at a
// time from the `start` cursor that came with the details. Kept oldest first, with their resolved references.
function useEarlierComments(item: WorkItem, start: string | null, onSignedOut: () => void, replyTo?: string) {
  const [page, setPage] = useState({ comments: [] as ItemComment[], before: start, references: {} as ItemDetails["references"] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refreshed details bring a new cursor; start over from it.
  useEffect(() => {
    setPage({ comments: [], before: start, references: {} });
    setError(null);
  }, [start, item.url]);
  const load = () => {
    if (!page.before || loading) return;
    setLoading(true);
    setError(null);
    api
      .earlierComments(item, page.before, replyTo)
      .then(
        (next) =>
          setPage((current) => ({
            comments: [...next.comments, ...current.comments],
            before: next.before,
            references: { ...current.references, ...next.references },
          })),
        (e) => (e instanceof UnauthorizedError ? onSignedOut() : setError((e as Error).message)),
      )
      .finally(() => setLoading(false));
  };
  return { ...page, loading, error, load };
}

function LoadEarlier({ earlier, remaining, noun }: { earlier: Earlier; remaining: number; noun: string }) {
  if (!earlier.before || remaining <= 0) return null;
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" size="sm" onClick={earlier.load} disabled={earlier.loading}>
        {earlier.loading ? <RefreshCw className="animate-spin" /> : <ChevronDown />}
        Load earlier {noun} <span className="text-muted-foreground">{remaining} more</span>
      </Button>
      {earlier.error && (
        <span role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5" /> {earlier.error}
        </span>
      )}
    </div>
  );
}

// Lets links deep inside rendered bodies open board items in the preview.
const BoardContext = createContext<{ boardItems: WorkItem[]; onOpenItem: (item: WorkItem) => void }>({ boardItems: [], onOpenItem: () => {} });

// For a link to a GitHub item: the board item it points to, if any, and a click handler that opens that item in the
// preview. Modified clicks and items not on the board go to GitHub.
function useBoardLink(target: { owner: string; repo: string; number: number } | undefined) {
  const { boardItems, onOpenItem } = useContext(BoardContext);
  const onBoard = target && boardItems.find((i) => sameItem(i, target));
  const onClick = (e: MouseEvent) => {
    if (!onBoard || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpenItem(onBoard);
  };
  return { onBoard, onClick };
}

// Items connected to this one, as the same chips as references in bodies (details on hover). First GitHub's
// "Development" links, marked with an icon: the issues a PR closes, or the PRs that close an issue. Then, unmarked,
// everything mentioned in the body and comments or that mentions this item.
function RelatedItems({ item, details }: { item: WorkItem; details: ItemDetails }) {
  const seen = new Set([itemKey(item).toLowerCase()]);
  const unseen = (other: LinkedItem | ReferencedItem) => {
    const key = itemKey(other).toLowerCase();
    return !seen.has(key) && !!seen.add(key);
  };
  // References carry more for the hover card (author, excerpt), so they're used when the same item is in both.
  const richer = (other: LinkedItem) => details.references[itemKey(other).toLowerCase()] ?? other;
  const closing = details.linked.filter(unseen).map(richer);
  const mentioned = [...Object.values(details.references), ...details.timeline.flatMap((e) => (e.source ? [richer(e.source)] : []))].filter(unseen);
  if (closing.length + mentioned.length === 0) return null;
  const closingLabel = item.type === "pr" ? "Closed when this PR merges" : "Closes this issue when merged";
  return (
    <Section title="Related">
      <div className="flex flex-wrap gap-1.5">
        {closing.map((other) => (
          <ItemChip key={other.url} item={other} text={shortRef(item, other)} closing={closingLabel} />
        ))}
        {mentioned.map((other) => (
          <ItemChip key={other.url} item={other} text={shortRef(item, other)} />
        ))}
      </div>
    </Section>
  );
}

// "#123" within the same repo, "owner/repo#123" elsewhere.
const shortRef = (from: WorkItem, to: LinkedItem | ReferencedItem) =>
  to.owner.toLowerCase() === from.owner.toLowerCase() && to.repo.toLowerCase() === from.repo.toLowerCase() ? `#${to.number}` : itemKey(to);

function PreviewSidebar({
  item,
  details,
  onShowComment,
  onViewAll,
}: {
  item: WorkItem;
  details: ItemDetails;
  onShowComment: (url: string) => void;
  onViewAll: () => void;
}) {
  return (
    <>
      {/* Keyed so the rows collapse again for each item. */}
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
            {/* Shortest first, which tends to pack the wrapped rows tighter. */}
            {details.labels.toSorted((a, b) => a.name.length - b.name.length).map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        </Section>
      )}
      {details.assignees.length > 0 && (
        <Section title="Assignees">
          <PeopleList people={details.assignees} />
        </Section>
      )}
      <RelatedItems item={item} details={details} />
      <Timeline details={details} onShowComment={onShowComment} onViewAll={onViewAll} />
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

// The verb shown after the actor. The timeline only says what kind of thing happened; labels, titles, assignees
// and referencing items are left out to keep it minimal.
function describe(e: TimelineEvent): { verb: string; color?: string } {
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

// Comments (and replies) the conversation tab shows, by URL. Decided from the data rather than the DOM, since the
// conversation may be on a tab that isn't showing.
function loadedCommentUrls(details: ItemDetails) {
  return new Set(
    [...details.comments.latest, ...(details.discussion?.answer ? [details.discussion.answer] : [])].flatMap((c) => [
      c.url,
      ...(c.replies?.latest.map((r) => r.url) ?? []),
    ]),
  );
}

// How many of the latest events the sidebar shows; the History tab has them all.
const SIDEBAR_EVENTS = 6;

function Timeline({ details, onShowComment, onViewAll }: { details: ItemDetails; onShowComment: (url: string) => void; onViewAll: () => void }) {
  const loadedComments = loadedCommentUrls(details);
  // "Opened" is the oldest event, so it only shows when everything fits.
  const showOpened = details.author !== null && details.timeline.length < SIDEBAR_EVENTS;
  return (
    <Section title="Timeline">
      <div className="pb-1">
        <ol className="relative space-y-1 before:absolute before:top-3 before:bottom-3 before:left-4 before:-translate-x-1/2 before:w-px before:bg-border">
          {details.timeline.slice(0, SIDEBAR_EVENTS).map((e, i) => {
            const Icon = TIMELINE_ICONS[e.kind];
            const { verb, color } = describe(e);
            const actor = e.actor?.login ?? "ghost";
            return (
              // The row's own link is an overlay behind the content rather than a wrapper, so the username inside can
              // link to the profile without nesting one link in another.
              <li key={`${e.kind}-${e.createdAt}-${i}`} className="relative flex w-full items-start gap-2 rounded-md p-1">
                {e.url && (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${actor} ${verb}`}
                    className="absolute inset-0 rounded-md hover:bg-muted"
                    // Comments loaded in the conversation tab are shown there instead of opened on GitHub.
                    onClick={(ev) => {
                      if ((e.kind !== "commented" && e.kind !== "reviewed") || !loadedComments.has(e.url!)) return;
                      ev.preventDefault();
                      onShowComment(e.url!);
                    }}
                  />
                )}
                {/* pointer-events is inherited through display: contents, so clicks on the icon reach the row link. */}
                <span className="pointer-events-none contents">
                  <TimelineIcon icon={Icon} color={color} actor={e.actor} />
                </span>
                <span className="pointer-events-none relative flex min-w-0 flex-1 items-baseline gap-1.5 pt-0.5">
                  <span className="min-w-0 truncate">
                    <UserLink user={e.actor} avatar={false} className="pointer-events-auto" />{" "}
                    <span className={cn("text-muted-foreground", color)}>{verb}</span>
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>
                    {relativeTime(e.createdAt)}
                  </span>
                </span>
              </li>
            );
          })}
          {showOpened && details.author && (
            <li className="flex items-start gap-2 p-1">
              <TimelineIcon icon={CircleDot} actor={details.author} />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 pt-0.5">
                <span className="truncate">
                  <UserLink user={details.author} avatar={false} /> <span className="text-muted-foreground">opened</span>
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(details.createdAt)}</span>
              </span>
            </li>
          )}
        </ol>
      </div>
      <Button variant="outline" size="sm" onClick={onViewAll}>
        <History /> View all
      </Button>
    </Section>
  );
}

// The sidebar's timeline expanded into its own tab, newest first: each event with what it was about (the label, new
// title, assignee or reviewer, comment or review text, commit details, referencing item, merge or force-push).
// Commits open their diff in place (with the diffs flag on), and comments open in the conversation tab when it has them.
function HistoryTab({
  item,
  details,
  diffs,
  generation,
  onSignedOut,
  onShowComment,
}: {
  item: WorkItem;
  details: ItemDetails;
  // Whether commits open their diff (the diffs feature flag).
  diffs: boolean;
  generation: number;
  onSignedOut: () => void;
  onShowComment: (url: string) => void;
}) {
  const [commit, setCommit] = useState<string | null>(null);
  // A different item starts on its history.
  useEffect(() => setCommit(null), [item.url]);
  if (commit && item.type === "pr" && diffs) {
    return <CommitDiff pr={item} sha={commit} onSelect={setCommit} generation={generation} onSignedOut={onSignedOut} />;
  }

  const loadedComments = loadedCommentUrls(details);
  return (
    <div className="h-full overflow-y-auto p-4">
      <ol className="relative max-w-3xl space-y-1 before:absolute before:top-4 before:bottom-4 before:left-5 before:w-px before:-translate-x-1/2 before:bg-border">
        {details.timeline.map((e, i) => {
          const { verb, color } = describe(e);
          const openComment = (e.kind === "commented" || e.kind === "reviewed") && e.url && loadedComments.has(e.url) ? () => onShowComment(e.url!) : undefined;
          const openCommit = diffs && e.commit && item.type === "pr" ? () => setCommit(e.commit!.sha) : undefined;
          return (
            <HistoryRow
              key={`${e.kind}-${e.createdAt}-${i}`}
              icon={TIMELINE_ICONS[e.kind]}
              color={color}
              actor={e.actor}
              verb={HISTORY_VERBS[e.kind] ?? verb}
              detail={<HistoryDetail event={e} />}
              createdAt={e.createdAt}
              url={e.url}
              onOpen={openComment ?? openCommit}
            >
              {e.commit && <CommitCard commit={e.commit} onOpen={openCommit} />}
              {e.excerpt && <Excerpt text={e.excerpt} onOpen={openComment} />}
            </HistoryRow>
          );
        })}
        {details.author && (
          <HistoryRow icon={CircleDot} actor={details.author} verb="opened this" createdAt={details.createdAt} url={item.url} />
        )}
      </ol>
      <a href={item.url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-muted-foreground hover:underline">
        Showing the latest {details.timeline.length} events · full history on GitHub
      </a>
    </div>
  );
}

// Where the sidebar's short verb leaves the subject out; HistoryDetail names it.
const HISTORY_VERBS: Partial<Record<TimelineEvent["kind"], string>> = {
  labeled: "added the label",
  unlabeled: "removed the label",
  assigned: "assigned",
  review_requested: "requested a review from",
  renamed: "changed the title",
  referenced: "referenced this in",
  force_pushed: "force-pushed the branch",
};

function HistoryDetail({ event: e }: { event: TimelineEvent }) {
  switch (e.kind) {
    case "labeled":
    case "unlabeled":
      return e.label ? <LabelChip label={e.label} /> : null;
    case "assigned":
    case "review_requested":
      return e.subject ? <UserLink user={e.subject} /> : <span className="font-medium">{e.detail}</span>;
    case "renamed":
      return (
        <>
          {e.previousTitle && <span className="text-muted-foreground line-through">{e.previousTitle}</span>}
          {e.previousTitle && <span className="text-muted-foreground">→</span>}
          <span className="font-medium">{e.detail}</span>
        </>
      );
    case "referenced":
      return e.source ? <SourceLink source={e.source} /> : <span className="font-medium">{e.detail}</span>;
    case "merged":
      return e.merge ? (
        <>
          <ShortSha sha={e.merge.sha} />
          {e.merge.into && (
            <>
              <span className="text-muted-foreground">into</span>
              <code className="rounded bg-muted px-1 font-mono text-xs">{e.merge.into}</code>
            </>
          )}
        </>
      ) : null;
    case "force_pushed":
      return e.forcePush?.before && e.forcePush.after ? (
        <>
          <span className="text-muted-foreground">from</span> <ShortSha sha={e.forcePush.before} />
          <span className="text-muted-foreground">to</span> <ShortSha sha={e.forcePush.after} />
        </>
      ) : null;
    default:
      return null;
  }
}

function ShortSha({ sha }: { sha: string }) {
  return (
    <code className="rounded bg-muted px-1 font-mono text-xs" title={sha}>
      {sha.slice(0, 7)}
    </code>
  );
}

// The issue or PR that referenced this one, with its state; opens in the preview when it's on the board.
function SourceLink({ source }: { source: LinkedItem }) {
  const { onBoard, onClick } = useBoardLink(source);
  const [Icon, color, label] = stateIcon(onBoard ?? source);
  return (
    <a href={source.url} target="_blank" rel="noreferrer" onClick={onClick} className="inline-flex min-w-0 items-baseline gap-1 font-medium hover:underline">
      <Icon className={cn("size-3.5 shrink-0 self-center", color)} aria-label={label} />
      <span className="font-normal text-muted-foreground">{itemKey(source)}</span>
      <span className="[overflow-wrap:anywhere]">{source.title}</span>
    </a>
  );
}

// A commit's message, size and checks; opens its diff.
function CommitCard({ commit, onOpen }: { commit: NonNullable<TimelineEvent["commit"]>; onOpen?: () => void }) {
  const [headline, ...rest] = commit.message.split("\n");
  const body = rest.join("\n").trim();
  const [ChecksIcon, checksColor, checksLabel] = checksIcon(commit.checks) ?? [];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="block w-full space-y-1 rounded-md border bg-card px-3 py-2 text-left hover:bg-muted/50 disabled:hover:bg-transparent"
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{headline}</span>
        {ChecksIcon && <ChecksIcon className={cn("size-4 shrink-0", checksColor)} aria-label={checksLabel} />}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
      </span>
      {body && <span className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{body}</span>}
      <span className="flex items-center gap-2 text-xs">
        <span className="text-emerald-400">+{commit.additions}</span>
        <span className="text-red-400">−{commit.deletions}</span>
        {commit.changedFiles !== null && (
          <span className="text-muted-foreground">
            {commit.changedFiles} {commit.changedFiles === 1 ? "file" : "files"}
          </span>
        )}
      </span>
    </button>
  );
}

// The start of a comment's or review's text; opens the comment when the conversation tab has it.
function Excerpt({ text, onOpen }: { text: string; onOpen?: () => void }) {
  const quote = <span className="line-clamp-2 border-l-2 pl-3 text-muted-foreground">{text}</span>;
  return onOpen ? (
    <button type="button" onClick={onOpen} className="block w-full rounded-sm text-left hover:text-foreground [&>span]:hover:text-foreground">
      {quote}
    </button>
  ) : (
    quote
  );
}

// Styled like the issue and PR chips in descriptions.
function LabelChip({ label }: { label: { name: string; color: string } }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium">
      <Tag className="size-3.5 shrink-0" style={{ color: `#${label.color}` }} />
      {label.name}
    </span>
  );
}

function HistoryRow({
  icon,
  color,
  actor,
  verb,
  detail,
  createdAt,
  url,
  onOpen,
  children,
}: {
  icon: LucideIcon;
  color?: string;
  actor: Person | null;
  verb: string;
  detail?: ReactNode;
  createdAt: string;
  url: string | null;
  // Shows the event in the app (a loaded comment, a commit's diff) instead of opening it on GitHub.
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex items-start gap-3 rounded-md p-2">
      <TimelineIcon icon={icon} color={color} actor={actor} />
      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
        {/* Centered rather than on the baseline, so label chips and avatars line up with the text. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <UserLink user={actor} avatar={false} />
          <span className={cn("text-muted-foreground", color)}>{verb}</span>
          {detail}
          {/* The time links to the event, like GitHub's. */}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(ev) => {
                if (!onOpen || ev.metaKey || ev.ctrlKey) return;
                ev.preventDefault();
                onOpen();
              }}
              className="ml-auto shrink-0 text-xs text-muted-foreground hover:underline"
              title={new Date(createdAt).toLocaleString()}
            >
              {relativeTime(createdAt)} ago
            </a>
          ) : (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={new Date(createdAt).toLocaleString()}>
              {relativeTime(createdAt)} ago
            </span>
          )}
        </div>
        {children}
      </div>
    </li>
  );
}

// One panel with a collapsible row each for the branch and its changes, reviews and checks.
function PullRequestSummary({ pr }: { pr: NonNullable<ItemDetails["pr"]> }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border">
      <ChangesSummary pr={pr} />
      <ReviewsSummary pr={pr} />
      {pr.checks.length > 0 && <ChecksSummary checks={pr.checks} />}
    </div>
  );
}

// A one-line summary that expands to its list; without a list it's a plain row. Rows sit in PullRequestSummary's panel.
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
      <Icon className={cn("size-4 shrink-0", iconColor)} />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs">{summary}</span>
    </>
  );
  if (!children) return <div className="flex items-center gap-2 px-3 py-2">{row}</div>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        {row}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", expanded && "rotate-180")} />
      </button>
      {expanded && <ul className="max-h-56 space-y-1 overflow-y-auto border-t bg-muted/30 p-2">{children}</ul>}
    </div>
  );
}

// Just information: the branches and size. The files themselves are in the Files changed tab.
function ChangesSummary({ pr }: { pr: NonNullable<ItemDetails["pr"]> }) {
  const conflicting = pr.mergeable === "CONFLICTING";
  return (
    <CollapsibleSummary
      icon={conflicting ? TriangleAlert : GitBranch}
      iconColor={conflicting ? "text-red-400" : "text-muted-foreground"}
      title={
        <span className="font-mono text-xs font-normal" title={`${pr.headRef} → ${pr.baseRef}`}>
          {pr.headRef} <span className="text-muted-foreground">→</span> {pr.baseRef}
        </span>
      }
      summary={
        <>
          {conflicting && (
            <span className="text-red-400" title="This branch has merge conflicts">
              conflicts
            </span>
          )}
          <span className="text-emerald-400">+{pr.additions}</span>
          <span className="text-red-400">−{pr.deletions}</span>
        </>
      }
    />
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
          ? [Eye, "text-amber-400"]
          : [CircleDashed, "text-muted-foreground"];
  const hasRows = pr.reviews.length + requested > 0;
  return (
    <CollapsibleSummary
      icon={icon}
      iconColor={iconColor}
      title="Reviews"
      summary={
        hasRows ? (
          <ReviewerStack
            reviewers={[
              ...pr.reviews.map((r) => ({ login: r.author?.login ?? "ghost", avatarUrl: r.author?.avatarUrl, state: r.state as string })),
              ...pr.requestedReviewers.map((login) => ({ login, avatarUrl: undefined, state: "REQUESTED" })),
            ]}
          />
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
                <UserLink user={review.author} className="min-w-0 truncate" />
                <span className={cn("shrink-0 text-xs", color)}>{label}</span>
              </li>
            );
          })}
          {pr.requestedReviewers.map((name) => (
            <li key={`requested-${name}`} className="flex items-center gap-2 px-1 py-0.5">
              <UserLink user={{ login: name }} className="min-w-0 truncate" />
              <span className="shrink-0 text-xs text-amber-400">Review requested</span>
            </li>
          ))}
        </>
      )}
    </CollapsibleSummary>
  );
}

// Each reviewer's verdict as a badge on their avatar.
const REVIEWER_BADGES: Record<string, [LucideIcon, string, string]> = {
  APPROVED: [CircleCheck, "text-emerald-400", "approved"],
  CHANGES_REQUESTED: [CircleX, "text-red-400", "requested changes"],
  COMMENTED: [MessageSquare, "text-muted-foreground", "commented"],
  DISMISSED: [CircleMinus, "text-muted-foreground", "review dismissed"],
  REQUESTED: [CircleDot, "text-amber-400", "review requested"],
};
const REVIEWER_STACK = 5;

// The reviews row's summary: who reviewed (or is asked to) and how, readable without expanding the row.
function ReviewerStack({ reviewers }: { reviewers: { login: string; avatarUrl: string | undefined; state: string }[] }) {
  const shown = reviewers.slice(0, REVIEWER_STACK);
  return (
    <span className="flex items-center gap-1.5">
      {shown.map(({ login, avatarUrl, state }) => {
        const [VerdictIcon, color, label] = REVIEWER_BADGES[state] ?? REVIEWER_BADGES.COMMENTED!;
        return (
          <span key={`${login}-${state}`} className="relative" title={`${login} ${label}`}>
            <Avatar className="size-5">
              {/* Requested reviewers come as names; GitHub serves any user's avatar by login. Teams fall back to the initial. */}
              <AvatarImage src={avatarUrl ?? `https://github.com/${login}.png?size=40`} alt={login} />
              <AvatarFallback className="text-[0.5rem]">{login[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <VerdictIcon className={cn("absolute -right-1 -bottom-1 size-3 rounded-full bg-popover", color)} aria-label={label} />
          </span>
        );
      })}
      {reviewers.length > shown.length && <span className="text-muted-foreground">+{reviewers.length - shown.length}</span>}
    </span>
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

function CommentView({
  item,
  comment,
  references: commentReferences,
  collapsed,
  onToggle,
  onSignedOut,
}: {
  item: WorkItem;
  comment: ItemComment;
  references: ItemDetails["references"];
  collapsed: boolean;
  onToggle: () => void;
  onSignedOut: () => void;
}) {
  const replies = comment.replies;
  const earlier = useEarlierComments(item, replies?.before ?? null, onSignedOut, comment.id);
  const references = { ...commentReferences, ...earlier.references };
  // Oldest first, like GitHub's threads, so earlier replies load at the top.
  const threadReplies = [...earlier.comments, ...(replies?.latest ?? [])];
  // A review may have only a verdict, or only inline comments.
  const hasBody = comment.bodyHTML !== "";
  const hasReplies = !!replies && replies.total > 0;
  return (
    <div
      data-comment-url={comment.url}
      className={cn(
        "relative scroll-mt-4 overflow-hidden rounded-lg border bg-popover",
        // Tinted by mixing into the card color rather than a translucent background: the card has to stay opaque so
        // the thread line behind it doesn't show through.
        (comment.isAnswer || comment.review === "APPROVED") &&
          "border-emerald-400/40 bg-[color-mix(in_oklab,var(--color-emerald-400)_8%,var(--color-popover))]",
        comment.review === "CHANGES_REQUESTED" && "border-red-400/40 bg-[color-mix(in_oklab,var(--color-red-400)_8%,var(--color-popover))]",
      )}
    >
      <CommentHeader
        comment={comment}
        className={cn("bg-muted/40 py-2 pr-3 pl-1.5", !collapsed && hasBody && "border-b")}
        toggle={
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand comment" : "Collapse comment"}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className={cn("size-4", collapsed && "-rotate-90")} />
          </button>
        }
      />
      {!collapsed && hasBody && (
        <div className="px-3 py-2">
          <GitHubHtml html={comment.bodyHTML} references={references} />
        </div>
      )}
      {/* Discussion replies, or a review's inline code comments. */}
      {!collapsed && replies && hasReplies && (
        <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
          <LoadEarlier earlier={earlier} remaining={replies.total - threadReplies.length} noun={comment.review ? "comments" : "replies"} />
          {threadReplies.map((reply) => (
            <div key={reply.url} data-comment-url={reply.url} className="scroll-mt-4 space-y-1.5 border-l-2 pl-3">
              {reply.code && <CodeContext code={reply.code} />}
              <CommentHeader comment={reply} />
              <GitHubHtml html={reply.bodyHTML} references={references} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// What a review's author did, shown after their name.
const REVIEW_HEADINGS: Record<NonNullable<ItemComment["review"]>, [string, string]> = {
  APPROVED: ["approved these changes", "text-emerald-400"],
  CHANGES_REQUESTED: ["requested changes", "text-red-400"],
  COMMENTED: ["reviewed", ""],
  DISMISSED: ["reviewed (dismissed)", ""],
};

// The end of the diff hunk an inline review comment is on: the commented line and the few before it.
function CodeContext({ code }: { code: NonNullable<ItemComment["code"]> }) {
  const lines = code.diffHunk.split("\n").filter((line) => !line.startsWith("@@")).slice(-4);
  return (
    <div className="overflow-hidden rounded-md border text-xs">
      <div className="truncate border-b bg-muted/50 px-2 py-1 font-mono text-muted-foreground" title={code.path}>
        {code.path}
        {code.line !== null && `:${code.line}`}
      </div>
      <div className="overflow-x-auto py-1 font-mono leading-5">
        {lines.map((line, i) => (
          <div key={i} className={cn("px-2 whitespace-pre", line.startsWith("+") && "bg-emerald-500/10", line.startsWith("-") && "bg-red-500/10")}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentHeader({ comment, className, toggle }: { comment: ItemComment; className?: string; toggle?: ReactNode }) {
  const [reviewVerb, reviewColor] = comment.review ? REVIEW_HEADINGS[comment.review] : [];
  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      {toggle}
      <UserLink user={comment.author} />
      {reviewVerb && <span className={reviewColor}>{reviewVerb}</span>}
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

type Reference = { kind: "user" | "issue" | "pull_request" | "discussion"; text: string; href: string; key: string | null; slot: HTMLElement };

const REFERENCE_ICONS: Record<Exclude<Reference["kind"], "user">, LucideIcon> = {
  issue: CircleDot,
  pull_request: GitPullRequest,
  discussion: MessagesSquare,
};

// GitHub renders and sanitizes bodyHTML server-side, so it's safe to inject. Links open in a new tab so the
// dialog (and the board behind it) stay put. Mentions (`user-mention`) and issue/PR/discussion links (see
// referenceLinkKind) are swapped for placeholders that React renders into, so
// they get the app's own links and hover cards. The HTML carries no item state; the server resolves it into
// `references`, and unresolved ones stay neutral without a card.
function GitHubHtml({ html, references: resolved }: { html: string; references: ItemDetails["references"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<Element>>(new Set());
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer");
      const kind = a.classList.contains("user-mention")
        ? "user"
        : referenceLinkKind({ className: a.className, text: a.textContent ?? "", href: a.href, hovercardType: a.dataset.hovercardType });
      if (!kind) continue;
      const slot = document.createElement("span");
      Object.assign(slot.dataset, { reference: kind, text: (a.textContent ?? "").replace(/^@/, ""), href: a.href, url: a.dataset.url ?? a.href });
      a.replaceWith(slot);
    }
    // Collected from the placeholders rather than the links, since StrictMode runs this twice on the same DOM.
    setReferences(
      [...root.querySelectorAll<HTMLElement>("span[data-reference]")].map((slot) => {
        const kind = slot.dataset.reference as Reference["kind"];
        return { kind, text: slot.dataset.text!, href: slot.dataset.href!, key: kind === "user" ? null : referenceKey(slot.dataset.url!), slot };
      }),
    );
    setHeadings(findHeadings(root));
    setCollapsed(new Set());
  }, [html]);

  // A collapsed heading hides everything after it up to the next heading of the same or a higher level. Headings
  // are only taken from the top level, where GitHub puts them, so a section is a run of sibling blocks.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const byBlock = new Map(headings.map((h) => [h.block, h]));
    const open: { level: number; collapsed: boolean }[] = [];
    for (const child of root.children) {
      const heading = byBlock.get(child);
      if (heading) while (open.length > 0 && open.at(-1)!.level >= heading.level) open.pop();
      (child as HTMLElement).hidden = open.some((h) => h.collapsed);
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
        // Inline code is a muted chip like the mention and reference pills, instead of Typography's bold text in
        // literal backticks; code blocks keep their own background.
        className="prose prose-sm prose-invert max-w-none [overflow-wrap:anywhere] prose-pre:overflow-x-auto prose-img:inline prose-img:my-0 prose-code:rounded-md prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none [&_pre_code]:bg-transparent [&_pre_code]:p-0"
        dangerouslySetInnerHTML={{ __html: html }}
        // Clicking anywhere on a heading toggles it, except on links inside it or when selecting its text.
        onClick={(e) => {
          const target = e.target as Element;
          const heading = headings.find((h) => h.block.contains(target));
          if (heading && !target.closest("a") && !window.getSelection()?.toString()) toggle(heading.block);
        }}
      />
      {references.map((reference, i) => createPortal(<ReferenceChip reference={reference} resolved={resolved} />, reference.slot, i))}
      {headings.map((heading, i) =>
        createPortal(
          <button
            type="button"
            aria-expanded={!collapsed.has(heading.block)}
            aria-label={collapsed.has(heading.block) ? "Expand section" : "Collapse section"}
            onClick={() => toggle(heading.block)}
            className={cn(
              "not-prose ml-1.5 inline-flex size-5 items-center justify-center rounded align-middle text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100",
              !collapsed.has(heading.block) && "opacity-0 group-hover/heading:opacity-100",
            )}
          >
            <ChevronDown className={cn("size-4", collapsed.has(heading.block) && "-rotate-90")} />
          </button>,
          heading.slot,
          `heading-${i}`,
        ),
      )}
    </>
  );
}

type Heading = { level: number; block: Element; slot: HTMLElement };

// Top-level headings, either bare or in GitHub's newer `<div class="markdown-heading">` wrapper, each given a slot
// at its end for the collapse toggle. Idempotent, since StrictMode runs the effect twice on the same DOM.
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
      h.classList.add("group/heading", "cursor-pointer");
    }
    headings.push({ level: Number(h.tagName[1]), block, slot });
  }
  return headings;
}

function ReferenceChip({ reference: { kind, text, href, key }, resolved }: { reference: Omit<Reference, "slot">; resolved: ItemDetails["references"] }) {
  if (kind === "user") return <UserLink user={{ login: text, url: href }} pill className="not-prose" />;
  const item = key ? resolved[key] : undefined;
  if (item) return <ItemChip item={item} text={text} href={href} />;
  // Unresolved (no access, or over the limit): neutral, without a card.
  const Icon = REFERENCE_ICONS[kind];
  return (
    <a href={href} target="_blank" rel="noreferrer" className={CHIP_CLASS}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {text}
    </a>
  );
}

const CHIP_CLASS = "not-prose inline-flex items-center gap-1 rounded-md bg-muted px-1.5 align-middle font-medium text-foreground hover:bg-accent";

// An issue, PR or discussion as a chip with its state, and its details in a card on hover. Opens in the preview
// when it's on the board. `closing` marks a closing link, with the label for its icon.
function ItemChip({ item, text, href, closing }: { item: LinkedItem | ReferencedItem; text: string; href?: string; closing?: string }) {
  const { onBoard, onClick } = useBoardLink(item);
  const [Icon, color, label] = stateIcon(onBoard ?? item);
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <a href={href ?? item.url} target="_blank" rel="noreferrer" onClick={onClick} className={CHIP_CLASS}>
          {closing && <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-label={closing} />}
          <Icon className={cn("size-3.5 shrink-0", color)} aria-label={label} />
          {text}
        </a>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <ReferenceCard item={item} />
      </HoverCardContent>
    </HoverCard>
  );
}

// Linked items have no author, date or excerpt; those lines are left out for them.
function ReferenceCard({ item }: { item: LinkedItem | ReferencedItem }) {
  const [Icon, color, label] = stateIcon(item);
  const { onBoard, onClick } = useBoardLink(item);
  return (
    <div className="space-y-2">
      <div className="truncate text-xs text-muted-foreground">
        {item.owner}/{item.repo}
        {"createdAt" in item && <> · opened {relativeTime(item.createdAt)} ago</>}
      </div>
      <div className="flex gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", color)} aria-label={label} />
        <a href={item.url} target="_blank" rel="noreferrer" onClick={onClick} className="font-medium hover:underline">
          {item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
          {!onBoard && <SquareArrowOutUpRight className="ml-1 inline size-3 align-baseline text-muted-foreground" aria-label="Opens on GitHub" />}
        </a>
      </div>
      {"excerpt" in item && item.excerpt && <p className="line-clamp-3 text-muted-foreground">{item.excerpt}</p>}
      {"author" in item && item.author && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserLink user={item.author} /> · {label}
        </div>
      )}
    </div>
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

function PeopleList({ people }: { people: Person[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {people.map((p) => (
        <UserLink key={p.login} user={p} />
      ))}
    </div>
  );
}

const SUMMARY_ROWS: [keyof ItemSummary, string][] = [
  ["what", "What"],
  ["who", "Who"],
  ["why", "Why"],
  ["related", "Related"],
  ["status", "Status"],
];

// @login, #number and owner/repo#number in the model's plain text. Not after a word character, so emails and
// URL fragments stay text.
const SUMMARY_TOKEN = /(?<![\w.@])@([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?)|(?<![\w/#])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;

// Summary text with mentions and references shown like those in descriptions. References take their state and
// hover card from the item's resolved references; ones not found there (rare, as they usually come from the
// body or comments) stay neutral.
function SummaryText({ text, item, references }: { text: string; item: WorkItem; references: ItemDetails["references"] }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SUMMARY_TOKEN)) {
    parts.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, login, owner = item.owner, repo = item.repo, number] = m;
    if (login) {
      parts.push(<UserLink key={m.index} user={{ login }} pill />);
      continue;
    }
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    const resolved = references[key];
    const sameRepo = `${owner}/${repo}`.toLowerCase() === `${item.owner}/${item.repo}`.toLowerCase();
    const kind = resolved?.type === "pr" ? "pull_request" : (resolved?.type ?? "issue");
    const reference = { kind, text: sameRepo ? `#${number}` : `${owner}/${repo}#${number}`, href: resolved?.url ?? `https://github.com/${owner}/${repo}/issues/${number}`, key } satisfies Omit<Reference, "slot">;
    parts.push(<ReferenceChip key={m.index} reference={reference} resolved={references} />);
  }
  parts.push(text.slice(last));
  return parts;
}

// A soft rainbow: every hue at the same lightness and low chroma, so on a 16px icon it reads as one gentle tint
// rather than a spectrum. The only color the AI summary adds to the UI.
const RAINBOW = [20, 80, 150, 230, 300].map((hue) => `oklch(0.8 0.1 ${hue})`);

// The AI sparkle, stroked with the rainbow. The gradient id is per instance, since several
// icons can be on screen at once.
function RainbowSparkles({ className }: { className?: string }) {
  const id = useId();
  return (
    <Sparkles className={className} stroke={`url(#${CSS.escape(id)})`} aria-hidden>
      <defs>
        {/* In the icon's 24×24 space: a per-path bounding box would be empty for the straight strokes, hiding them. */}
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
          {RAINBOW.map((color, i) => (
            <stop key={color} offset={i / (RAINBOW.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
      </defs>
    </Sparkles>
  );
}

// AI summary of the item, written on request from its full description, conversation and metadata: the TL;DR as
// a lead, then labelled rows (styled like the sidebar's section titles) so short answers don't float in whitespace.
function SummaryView({ item, references, onSignedOut }: { item: WorkItem; references: ItemDetails["references"]; onSignedOut: () => void }) {
  const [summary, setSummary] = useState<ItemSummary | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((e: unknown) => (e instanceof UnauthorizedError ? onSignedOut() : setError((e as Error).message)), [onSignedOut]);

  useEffect(() => {
    api.summary(item).then(setSummary, fail);
  }, [item, fail]);

  const generate = () => {
    setGenerating(true);
    setError(null);
    api
      .summary(item, true)
      .then(setSummary, fail)
      .finally(() => setGenerating(false));
  };

  const text = (value: string) => <SummaryText text={value} item={item} references={references} />;
  const outdated = summary !== null && item.updatedAt > summary.itemUpdatedAt;
  return (
    <div className="space-y-4" aria-busy={generating}>
      {error && (
        <p role="alert" className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-4 shrink-0" /> {error}
        </p>
      )}
      {!summary && !generating && (
        <div className="space-y-3">
          <p className="text-muted-foreground">A short AI summary of the description, conversation and metadata.</p>
          <Button variant="outline" size="sm" onClick={generate}>
            <RainbowSparkles /> Summarize
          </Button>
        </div>
      )}
      {!summary && generating && <LoadingBody />}
      {summary && (
        <>
          <div className={cn("space-y-4 transition-opacity", generating && "opacity-50")}>
            <p className="text-base leading-relaxed">{text(summary.tldr)}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5">
              {/* Fields the model left empty (nothing to say) are skipped. */}
              {SUMMARY_ROWS.filter(([key]) => summary[key].trim()).map(([key, label]) => (
                <div key={key} className="contents">
                  <dt className="text-xs leading-6 font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
                  <dd className="leading-6">{text(summary[key])}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate" title={`${summary.model}, ${new Date(summary.generatedAt).toLocaleString()}`}>
              Generated {relativeTime(summary.generatedAt)} ago
              {outdated && <span className="text-amber-400"> · item updated since</span>}
            </span>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={generate} disabled={generating}>
              <RefreshCw className={generating ? "animate-spin" : undefined} /> {generating ? "Regenerating…" : "Regenerate"}
            </Button>
          </div>
        </>
      )}
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
