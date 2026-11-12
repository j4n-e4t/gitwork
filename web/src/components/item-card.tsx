import { toast } from "sonner";
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Copy,
  EllipsisVertical,
  Eye,
  EyeOff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Check,
  Link2,
  Undo2,
  ListPlus,
  ListTodo,
  Lock,
  MessageSquare,
  MessageSquareCheck,
  MessageSquareX,
  MessagesSquare,
  SquareArrowOutUpRight,
  Star,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deadlineLabel } from "@/components/todos";
import { isClosed, itemKey, type HiddenItem, type LinkedItem, type PullRequest, type Todo, type WorkItem } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ActionProps = {
  item: WorkItem;
  hidden: boolean;
  onToggleWatching: () => void;
  onHide: (item: HiddenItem) => void;
  onAddTodo: () => void;
  // The card's compact header uses the small default; the dialog matches its taller header buttons.
  buttonSize?: "icon-xs" | "icon-sm";
};

export function copyLink(url: string) {
  navigator.clipboard.writeText(url).then(
    () => toast.success("Link copied"),
    () => toast.error("Couldn't copy the link"),
  );
}

type Props = ActionProps & {
  onOpen: () => void;
  // Open todos linked to this item.
  todos: Todo[];
  // Linked PRs/issues (a PR and the issues it closes) that are also on the board.
  linked: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
  checkedOff: boolean;
  onCheckOff: (checkedOff: boolean) => void;
};

export function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

export function stateIcon(item: WorkItem | LinkedItem): [LucideIcon, string, string] {
  if (item.type === "discussion") {
    if (item.closed) {
      if (item.stateReason === "RESOLVED") return [MessageSquareCheck, "text-violet-400", "Closed as resolved"];
      const reason = item.stateReason === "DUPLICATE" ? "duplicate" : "outdated";
      return [MessageSquareX, "text-muted-foreground", `Closed as ${reason}`];
    }
    return [MessagesSquare, "text-emerald-400", "Open discussion"];
  }
  if (item.type === "issue") {
    if (item.state === "OPEN") return [CircleDot, "text-emerald-400", "Open issue"];
    if (item.stateReason === "NOT_PLANNED" || item.stateReason === "DUPLICATE") return [CircleSlash, "text-muted-foreground", "Closed as not planned"];
    return [CircleCheck, "text-violet-400", "Closed as completed"];
  }
  if (item.state === "MERGED") return [GitMerge, "text-violet-400", "Merged"];
  if (item.state === "CLOSED") return [GitPullRequestClosed, "text-red-400", "Closed"];
  if (item.isDraft) return [GitPullRequestDraft, "text-muted-foreground", "Draft"];
  return [GitPullRequest, "text-emerald-400", "Open"];
}

function checksIcon(checks: PullRequest["checks"]): [LucideIcon, string, string] | null {
  if (checks === "SUCCESS") return [CircleCheck, "text-emerald-400", "Checks passing"];
  if (checks === "FAILURE" || checks === "ERROR") return [CircleX, "text-red-400", "Checks failing"];
  if (checks === "PENDING" || checks === "EXPECTED") return [CircleDot, "text-amber-400", "Checks running"];
  return null;
}

function IconHint({ icon: Icon, className, label }: { icon: LucideIcon; className: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className={cn("size-4 shrink-0", className)} aria-label={label} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ItemCard({ item, hidden, onToggleWatching, onHide, onOpen, todos, onAddTodo, linked, onOpenItem, checkedOff, onCheckOff }: Props) {
  const repo = `${item.owner}/${item.repo}`;
  const [StateIcon, stateClass, stateLabel] = stateIcon(item);
  const checks = item.type === "pr" ? checksIcon(item.checks) : null;

  return (
    <Card size="sm" className={cn("gap-2 px-3", (hidden || checkedOff) && "opacity-50")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Avatar className="size-5">
          <AvatarImage src={item.ownerAvatarUrl} alt="" />
          <AvatarFallback>{item.owner[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 gap-1" title={`${repo}#${item.number}`}>
          <span className="truncate">{repo}</span>
          <span className="shrink-0 text-muted-foreground/70">#{item.number}</span>
        </span>
        <ItemActions item={item} hidden={hidden} onToggleWatching={onToggleWatching} onHide={onHide} onAddTodo={onAddTodo} />
      </div>

      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          // A plain click previews in-app; modified or middle clicks keep the normal "open GitHub" link behavior.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onOpen();
        }}
        className="font-medium leading-snug text-foreground [overflow-wrap:anywhere] hover:underline"
      >
        {item.title}
      </a>

      {linked.length > 0 && (
        <div className="flex flex-col gap-1">
          {linked.map((other) => {
            const [OtherIcon, otherClass, otherLabel] = stateIcon(other);
            const sameRepo = other.owner === item.owner && other.repo === item.repo;
            return (
              <button
                key={other.url}
                type="button"
                onClick={() => onOpenItem(other)}
                title={`${item.type === "pr" ? "Closes" : "Linked pull request"}: ${otherLabel.toLowerCase()} · ${other.title}`}
                className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Link2 className="size-3.5 shrink-0" />
                <OtherIcon className={cn("size-3.5 shrink-0", otherClass)} />
                <span className="shrink-0">{sameRepo ? `#${other.number}` : itemKey(other)}</span>
                <span className="truncate">{other.title}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {/* Badges take their natural width and wrap among themselves; the author gets whatever is left. */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <IconHint icon={StateIcon} className={stateClass} label={stateLabel} />
          {checks && <IconHint icon={checks[0]} className={checks[1]} label={checks[2]} />}
          {item.type === "pr" && item.reviewDecision === "APPROVED" && (
            <Badge variant="outline" className="text-emerald-400">
              Approved
            </Badge>
          )}
          {item.type === "pr" && item.reviewDecision === "CHANGES_REQUESTED" && (
            <Badge variant="outline" className="text-red-400">
              Changes requested
            </Badge>
          )}
          {item.type === "discussion" && (
            <>
              <Badge variant="outline" className="max-w-32 truncate" title={`Category: ${item.category}`}>
                {item.category}
              </Badge>
              {item.isAnswered === true && (
                <Badge variant="outline" className="text-emerald-400">
                  Answered
                </Badge>
              )}
              {item.isAnswered === false && !item.closed && (
                <Badge variant="outline" className="text-amber-400">
                  Unanswered
                </Badge>
              )}
              {item.locked && <IconHint icon={Lock} className="text-muted-foreground" label="Locked" />}
            </>
          )}
          {todos.length > 0 && <TodoBadge todos={todos} />}
          {item.comments > 0 && (
            <span className="flex items-center gap-1" title={`${item.comments} comment${item.comments === 1 ? "" : "s"}`}>
              <MessageSquare className="size-3.5" /> {item.comments}
            </span>
          )}
        </div>
        {item.author && (
          // When the name doesn't fit beside the avatar it wraps onto a second line, which the fixed height clips,
          // leaving just the picture.
          <span
            className="flex h-4 min-w-4 flex-1 basis-0 flex-wrap items-center justify-end gap-x-1.5 overflow-hidden"
            title={`${item.author} · updated ${new Date(item.updatedAt).toLocaleString()}`}
          >
            <Avatar className="size-4">
              {/* Missing from boards cached before avatars were fetched; the initial shows until the next refresh. */}
              {item.authorAvatarUrl && <AvatarImage src={item.authorAvatarUrl} alt="" />}
              <AvatarFallback className="text-[0.5rem]">{item.author[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="leading-4 whitespace-nowrap">{item.author}</span>
          </span>
        )}
      </div>
      <CheckOffButton item={item} checkedOff={checkedOff} onCheckOff={onCheckOff} />
    </Card>
  );
}

// The watch star and the "more" menu, shown on the card and in the preview dialog.
export function ItemActions({ item, hidden, onToggleWatching, onHide, onAddTodo, buttonSize = "icon-xs" }: ActionProps) {
  const watching = item.reasons.includes("watching");
  const involved = item.reasons.some((r) => r !== "watching");
  const repo = `${item.owner}/${item.repo}`;
  const key = itemKey(item);
  const noun = { pr: "PR", issue: "issue", discussion: "discussion" }[item.type];
  return (
    <>
      {/* Only items on the board purely because they're watched get a star: anything that involves you otherwise
          can't be watched (the server drops such bookmarks). */}
      {!involved && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={onToggleWatching}
          aria-pressed={watching}
          aria-label={watching ? `Stop watching ${key}` : `Watch ${key}`}
          title={watching ? "Stop watching" : "Watch"}
        >
          <Star className={cn(watching && "fill-amber-400 text-amber-400")} />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={buttonSize} aria-label={`More actions for ${key}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        {/* The default menu width follows the tiny trigger button; size to the labels instead. */}
        <DropdownMenuContent align="end" collisionPadding={8} className="w-auto max-w-80 min-w-48">
          <DropdownMenuItem asChild>
            <a href={item.url} target="_blank" rel="noreferrer">
              <SquareArrowOutUpRight /> Open on GitHub
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copyLink(item.url)}>
            <Copy /> Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddTodo}>
            <ListPlus /> Add todo
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {hidden ? (
            <DropdownMenuItem disabled>
              <Eye /> Hidden — unhide from the Hidden menu
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => onHide({ kind: "pr", key })}>
                <EyeOff /> <span className="truncate">Hide this {noun}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onHide({ kind: "repo", key: repo })}>
                <EyeOff /> <span className="truncate">Hide repo {repo}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onHide({ kind: "owner", key: item.owner })}>
                <EyeOff /> <span className="truncate">Hide everything from {item.owner}</span>
              </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

// Tints the check-off button in the state's color: merged and completed are violet, closed PRs red. Closed as
// not planned, duplicate or outdated stays neutral.
const CHECK_OFF_TINTS: Record<string, string> = {
  "text-violet-400": "bg-violet-500/15 text-violet-400 hover:bg-violet-500/25",
  "text-red-400": "bg-red-500/15 text-red-400 hover:bg-red-500/25",
};

// Closed and merged items leave the board only when checked off, never on their own.
export function CheckOffButton({ item, checkedOff, onCheckOff }: { item: WorkItem; checkedOff: boolean; onCheckOff: (checkedOff: boolean) => void }) {
  if (!isClosed(item)) return null;
  const [, stateClass, stateLabel] = stateIcon(item);
  return (
    <Button
      variant={checkedOff ? "ghost" : "secondary"}
      size="sm"
      className={cn(!checkedOff && CHECK_OFF_TINTS[stateClass])}
      onClick={() => onCheckOff(!checkedOff)}
    >
      {checkedOff ? <Undo2 /> : <Check />}
      {checkedOff ? "Restore" : `Check off · ${stateLabel}`}
    </Button>
  );
}

// Red count of open todos; the tooltip lists them with their deadlines.
function TodoBadge({ todos }: { todos: Todo[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" aria-label={`${todos.length} open todo${todos.length === 1 ? "" : "s"}`}>
          <ListTodo /> {todos.length}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <ul>
          {todos.map((t) => (
            <li key={t.id}>
              {t.title}
              {t.deadline && <> · {deadlineLabel(t.deadline).label}</>}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
