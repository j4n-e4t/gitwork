import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronsRightLeft,
  EllipsisVertical,
  GripVertical,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Star,
} from "lucide-react";
import { CollapsedColumn } from "@/components/collapsed-column";
import { CheckOffButton, ItemActions, ItemCard } from "@/components/item-card";
import { ItemPreview } from "@/components/item-preview";
import { Settings } from "@/components/settings";
import { ItemTodos, newTodo, linkOf, TodoBoard, TodoDialog } from "@/components/todos";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
  api,
  isClosed,
  isHidden,
  itemKey,
  parseItemInput,
  sameItem,
  reasonApplies,
  moveReason,
  resolveReasonOrder,
  type HiddenItem,
  type ItemType,
  UnauthorizedError,
  type Me,
  type MissingBookmark,
  type RateLimit,
  type Reason,
  type Todo,
  type WorkItem,
  type WorkView,
} from "@/lib/api";
import { COLUMNS, MODES, TODOS_MODE, type Mode } from "@/lib/board";
import { cn } from "@/lib/utils";

// The mode and display toggles are per-browser conveniences; storage can be unavailable (private mode), so
// reads fall back to defaults and failed writes are ignored.
function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readStoredJson<T>(key: string): T | null {
  try {
    return JSON.parse(readStored(key) ?? "null");
  } catch {
    return null;
  }
}

function removeStored(...keys: string[]) {
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

const MODE_STORAGE_KEY = "work-view:mode";
// The signed-in user and their last board, so a reload renders instantly while the server is asked again.
// Cleared on sign-out, since the board can include private repositories.
const ME_STORAGE_KEY = "work-view:me";
const BOARD_STORAGE_KEY = "work-view:board";
type StoredBoard = { login: string; view: WorkView };
const SHOW_CHECKED_OFF_STORAGE_KEY = "work-view:show-checked-off";
const SHOW_HIDDEN_STORAGE_KEY = "work-view:show-hidden";
const COLLAPSED_STORAGE_KEY = "work-view:collapsed";

function readStoredCollapsed(): string[] {
  try {
    const value = JSON.parse(readStored(COLLAPSED_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const readStoredMode = (): Mode =>
  [...MODES, TODOS_MODE].find((m) => m.value === readStored(MODE_STORAGE_KEY))?.value ?? "pr";

// Settings is a hash route so the browser's back button returns to the board.
const SETTINGS_HASH = "#settings";

function useSettingsRoute() {
  const [open, setOpen] = useState(() => location.hash === SETTINGS_HASH);
  useEffect(() => {
    const onHashChange = () => setOpen(location.hash === SETTINGS_HASH);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return open;
}

// An item appears only in the column of its highest-ranked reason. Its other reasons stay on the item, so the
// star still reflects whether it's watched.
function inColumn(item: WorkItem, reason: Reason, precedence: Reason[]) {
  return precedence.find((r) => item.reasons.includes(r)) === reason;
}

// Pairs each PR with the issues it closes, in both directions, when both are among `items`.
function linksBetween(items: WorkItem[]) {
  const byUrl = new Map(items.map((item) => [item.url, item]));
  const links = new Map<string, WorkItem[]>();
  const link = (from: WorkItem, to: WorkItem) => links.set(from.url, [...(links.get(from.url) ?? []), to]);
  for (const pr of items) {
    if (pr.type !== "pr") continue;
    for (const url of pr.closes ?? []) {
      const issue = byUrl.get(url);
      if (!issue) continue;
      link(pr, issue);
      link(issue, pr);
    }
  }
  return links;
}

export function App() {
  // undefined while checking the session, null when signed out. A remembered user is shown while the check runs.
  const [me, setMe] = useState<Me | null | undefined>(() => readStoredJson<Me>(ME_STORAGE_KEY) ?? undefined);

  // Stable so Board's load callback (which depends on it) isn't recreated on every render.
  const signedOut = useCallback(() => {
    removeStored(ME_STORAGE_KEY, BOARD_STORAGE_KEY);
    setMe(null);
  }, []);

  useEffect(() => {
    // Any failure (401, or the server being unreachable) lands on the sign-in screen.
    api.me().then((next) => {
      writeStored(ME_STORAGE_KEY, JSON.stringify(next));
      setMe(next);
    }, signedOut);
  }, [signedOut]);

  if (me === undefined) return null;
  if (me === null) return <SignIn />;
  // Keyed by login so a different account never starts from the previous one's board.
  return <Board key={me.login} me={me} onSignedOut={signedOut} />;
}

function SignIn() {
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm items-center gap-4 px-6 py-8 text-center">
        <img src="/favicon.svg" alt="" className="size-12" />
        <h1 className="text-lg font-semibold">gitwork</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with GitHub to see your pull requests, issues and discussions.
        </p>
        <Button asChild>
          <a href="/auth/login">
            <LogIn /> Sign in with GitHub
          </a>
        </Button>
      </Card>
    </div>
  );
}

// A bar that empties as the hour's GitHub API points are spent; red once under a tenth is left.
function RateLimitMeter({ rateLimit }: { rateLimit: RateLimit }) {
  const { remaining, limit, resetAt } = rateLimit;
  const low = remaining < limit / 10;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between gap-4">
        <span>GitHub API points left</span>
        <span className={cn("tabular-nums", low && "text-destructive")}>
          {remaining.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div
        role="meter"
        aria-label="GitHub API points left"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={remaining}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", low ? "bg-destructive" : "bg-primary")}
          style={{ width: `${(remaining / limit) * 100}%` }}
        />
      </div>
      <div>Resets at {new Date(resetAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
    </div>
  );
}

function AccountMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  // Fetched each time the menu opens; it costs nothing against the limit.
  const [rateLimit, setRateLimit] = useState<RateLimit | "error" | null>(null);
  const onOpenChange = (open: boolean) => {
    if (open) api.rateLimit().then(setRateLimit, () => setRateLimit("error"));
  };
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-1.5" aria-label={`Account: ${me.login}`}>
          <Avatar size="sm">
            <AvatarImage src={me.avatarUrl} alt="" />
            <AvatarFallback>{me.login[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm sm:inline">{me.login}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuLabel>Signed in as {me.login}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal">
          {rateLimit === null ? (
            "GitHub API limit…"
          ) : rateLimit === "error" ? (
            "GitHub API limit unavailable"
          ) : (
            <RateLimitMeter rateLimit={rateLimit} />
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={SETTINGS_HASH}>
            <SettingsIcon /> Settings
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Board({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [view, setView] = useState<WorkView | null>(() => {
    const stored = readStoredJson<StoredBoard>(BOARD_STORAGE_KEY);
    return stored?.login === me.login ? stored.view : null;
  });
  const [loading, setLoading] = useState(false);
  // Separate so a background refetch succeeding doesn't wipe the message about a failed action.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => readStored(SHOW_HIDDEN_STORAGE_KEY) === "true");
  const [mode, setMode] = useState<Mode>(readStoredMode);
  const [showCheckedOff, setShowCheckedOff] = useState(() => readStored(SHOW_CHECKED_OFF_STORAGE_KEY) === "true");
  const settingsOpen = useSettingsRoute();
  // Collapsed column keys: a Reason for item columns, "todo:<bucket>" for todo columns.
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const [bookmarkInput, setBookmarkInput] = useState("");
  // Local order wins once the user rearranges, so a reload can't snap columns back mid-save.
  const [localOrder, setLocalOrder] = useState<Reason[] | null>(null);
  const [localPrecedence, setLocalPrecedence] = useState<Reason[] | null>(null);
  const [dragging, setDragging] = useState<Reason | null>(null);
  const [dropTarget, setDropTarget] = useState<Reason | null>(null);
  const [previewItem, setPreviewItem] = useState<WorkItem | null>(null);
  // Bookmarks added but not yet resolved by GitHub, shown as placeholder cards in Watching.
  // The todo in the create/edit dialog.
  const [todoDraft, setTodoDraft] = useState<Todo | null>(null);
  const [pendingBookmarks, setPendingBookmarks] = useState<(MissingBookmark & { type: ItemType })[]>([]);
  const loadSeq = useRef(0);
  const pendingMutations = useRef(0);

  const load = useCallback(async (fresh = false) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const next = await api.work(fresh);
      // Drop stale snapshots: a newer load started, or a write is still in flight that this snapshot
      // predates (applying it would briefly undo the optimistic change). That write triggers its own load.
      if (seq !== loadSeq.current || pendingMutations.current > 0) return;
      setView(next);
      // Only server answers are stored, never optimistic edits; each write is followed by a load anyway.
      writeStored(BOARD_STORAGE_KEY, JSON.stringify({ login: me.login, view: next } satisfies StoredBoard));
      setLoadError(null);
      setPendingBookmarks((pending) =>
        pending.filter((p) => !next.items.some((i) => sameItem(i, p)) && !next.missing.some((m) => sameItem(m, p))),
      );
      // Show the cached board right away, then replace it once GitHub answers.
      if (next.stale) void load(true);
    } catch (e) {
      if (e instanceof UnauthorizedError) onSignedOut();
      else if (seq === loadSeq.current) setLoadError((e as Error).message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [me.login, onSignedOut]);

  useEffect(() => {
    load();
  }, [load]);

  // Applies `optimistic` to the board immediately, sends the write, then refetches in the background once
  // no writes are pending. On failure the refetch also restores the server's real state.
  async function mutate(action: () => Promise<unknown>, optimistic?: (view: WorkView) => WorkView) {
    setActionError(null);
    if (optimistic) setView((v) => v && optimistic(v));
    pendingMutations.current++;
    let ok = true;
    try {
      await action();
    } catch (e) {
      ok = false;
      if (e instanceof UnauthorizedError) onSignedOut();
      else setActionError((e as Error).message);
    } finally {
      pendingMutations.current--;
    }
    if (pendingMutations.current === 0) load();
    return ok;
  }

  const setHidden = (item: HiddenItem, hide: boolean) =>
    mutate(
      () => api.setHidden(item, hide),
      (v) => {
        const rest = v.hidden.filter((h) => h.kind !== item.kind || h.key !== item.key);
        return { ...v, hidden: hide ? [...rest, item] : rest };
      },
    );

  const toggleWatching = async (item: WorkItem) => {
    const watch = !item.reasons.includes("watching");
    const ok = await mutate(
      () => api.setWatching(itemKey(item), watch),
      (v) => ({
        ...v,
        items: v.items.flatMap((i) => {
          if (i.url !== item.url) return [i];
          const reasons = watch ? [...i.reasons, "watching" as const] : i.reasons.filter((r) => r !== "watching");
          // An item that was only here because it was bookmarked leaves the board entirely.
          return reasons.length ? [{ ...i, reasons }] : [];
        }),
      }),
    );
    if (ok && watch) toast.success(`Watching ${itemKey(item)}`);
  };

  const removeMissing = (ref: MissingBookmark) =>
    mutate(
      () => api.setWatching(itemKey(ref), false),
      (v) => ({ ...v, missing: v.missing.filter((m) => itemKey(m) !== itemKey(ref)) }),
    );

  // Shows a placeholder until the background refetch brings the item's details. Input the client can't parse
  // goes straight to the server, which reports the error.
  async function addBookmark(event: FormEvent) {
    event.preventDefault();
    const input = bookmarkInput;
    const ref = parseItemInput(input);
    setBookmarkInput("");
    // Anything already on the board is either watched or involves you (and would have its bookmark dropped).
    if (ref && (view?.items.some((i) => sameItem(i, ref)) || view?.missing.some((m) => sameItem(m, ref)))) {
      toast.info(`${itemKey(ref)} is already on the board`);
      return;
    }
    const pending = ref && { ...ref, type: ref.type ?? (mode === "todos" ? "pr" : mode) };
    if (pending) setPendingBookmarks((p) => [...p.filter((b) => !sameItem(b, pending)), pending]);
    if (await mutate(() => api.setWatching(input, true))) {
      toast.success(`Watching ${ref ? itemKey(ref) : input.trim()}`);
    } else {
      if (pending) setPendingBookmarks((p) => p.filter((b) => !sameItem(b, pending)));
      setBookmarkInput((current) => current || input);
    }
  }

  const error = actionError ?? loadError;

  const saveTodo = (todo: Todo) =>
    mutate(
      () => api.saveTodo(todo),
      (v) => ({
        ...v,
        todos: v.todos.some((t) => t.id === todo.id) ? v.todos.map((t) => (t.id === todo.id ? todo : t)) : [...v.todos, todo],
      }),
    );

  const deleteTodo = (todo: Todo) =>
    mutate(
      () => api.deleteTodo(todo.id),
      (v) => ({ ...v, todos: v.todos.filter((t) => t.id !== todo.id) }),
    );

  const todos = view?.todos ?? [];
  const openTodosFor = (item: WorkItem) =>
    todos.filter((t) => !t.done && t.link && sameItem(t.link, item) && t.link.type === item.type);

  function changeMode(next: Mode) {
    setMode(next);
    writeStored(MODE_STORAGE_KEY, next);
  }

  function changeShowCheckedOff(next: boolean) {
    setShowCheckedOff(next);
    writeStored(SHOW_CHECKED_OFF_STORAGE_KEY, String(next));
  }

  // Checking off is how a closed or merged item leaves the board; it's never removed automatically.
  const setCheckedOff = (item: WorkItem, checkedOff: boolean) =>
    mutate(
      () => api.setDismissed(itemKey(item), checkedOff),
      (v) => {
        const rest = v.dismissed.filter((key) => key !== itemKey(item));
        return { ...v, dismissed: checkedOff ? [...rest, itemKey(item)] : rest };
      },
    );

  function toggleCollapsed(key: string) {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    writeStored(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
  }

  function changeShowHidden(next: boolean) {
    setShowHidden(next);
    writeStored(SHOW_HIDDEN_STORAGE_KEY, String(next));
  }

  // One saved order covers both modes; columns that don't apply to the current mode are skipped.
  const columnOrder = resolveReasonOrder(localOrder ?? view?.columnOrder ?? null);
  const precedence = resolveReasonOrder(localPrecedence ?? view?.precedence ?? null);
  // The todos view has its own columns.
  const visibleColumns = mode === "todos" ? [] : columnOrder.filter((r) => reasonApplies(r, mode));

  function moveColumn(reason: Reason, target: Reason) {
    if (reason === target) return;
    const next = moveReason(columnOrder, reason, target);
    setLocalOrder(next);
    api.setColumnOrder(next).catch((e) => setActionError(`Couldn't save column order: ${(e as Error).message}`));
  }

  // Local precedence wins for the same reason as localOrder.
  function movePrecedence(reason: Reason, target: Reason) {
    if (reason === target) return;
    const next = moveReason(precedence, reason, target);
    setLocalPrecedence(next);
    api.setPrecedence(next).catch((e) => setActionError(`Couldn't save precedence: ${(e as Error).message}`));
  }

  const hidden = view?.hidden ?? [];
  // The check-off only counts while the item is closed (the server also clears it when an item reopens).
  const isCheckedOff = (item: WorkItem) => isClosed(item) && (view?.dismissed ?? []).includes(itemKey(item));
  // The preview holds the item as it was when opened; its actions need the board's current copy (watching, state).
  // An item no longer on the board was only watched and has just been unwatched.
  const previewCurrent = previewItem && (view?.items.find((i) => i.url === previewItem.url) ?? { ...previewItem, reasons: [] });
  const previewTodos = previewCurrent ? openTodosFor(previewCurrent) : [];
  const previewActions = previewCurrent && (
    <>
      <CheckOffButton item={previewCurrent} checkedOff={isCheckedOff(previewCurrent)} onCheckOff={(c) => setCheckedOff(previewCurrent, c)} />
      <ItemActions
        item={previewCurrent}
        hidden={isHidden(previewCurrent, hidden)}
        onToggleWatching={() => toggleWatching(previewCurrent)}
        onHide={(item) => setHidden(item, true)}
        onAddTodo={() => setTodoDraft(newTodo(linkOf(previewCurrent)))}
        buttonSize="icon-sm"
      />
    </>
  );
  const visibleItems = (view?.items ?? []).filter(
    (item) => (showHidden || !isHidden(item, hidden)) && (showCheckedOff || !isCheckedOff(item)),
  );
  const modeItems = visibleItems.filter((item) => item.type === mode);
  const linkedItems = linksBetween(visibleItems);
  const countOf = (type: ItemType) => visibleItems.filter((item) => item.type === type).length;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        {settingsOpen ? (
          <div className="mr-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <a href="#" aria-label="Back to board">
                <ArrowLeft />
              </a>
            </Button>
            <h1 className="text-base font-semibold">Settings</h1>
          </div>
        ) : (
          <>
            <div className="mr-auto flex items-center gap-3">
              <h1 className="sr-only">gitwork</h1>
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(value) => value && changeMode(value as Mode)}
                aria-label="Show pull requests, issues, discussions or todos"
              >
                {[...MODES, TODOS_MODE].map(({ value, label, icon: ModeIcon }) => (
                  <ToggleGroupItem key={value} value={value}>
                    <ModeIcon /> {label}
                    {view && (
                      <span className="text-muted-foreground">
                        {value === "todos" ? todos.filter((t) => !t.done).length : countOf(value)}
                      </span>
                    )}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {mode === "todos" ? (
              <Button onClick={() => setTodoDraft(newTodo())} disabled={!view}>
                <Plus /> New todo
              </Button>
            ) : (
              <form onSubmit={addBookmark} className="flex w-full gap-2 sm:w-96">
                <Input
                  value={bookmarkInput}
                  onChange={(e) => setBookmarkInput(e.target.value)}
                  placeholder="Watch a PR, issue or discussion: URL or owner/repo#123"
                  aria-label="PR, issue or discussion to watch"
                  required
                />
                <Button type="submit" variant="secondary">
                  <Star /> Watch
                </Button>
              </form>
            )}
            <Button variant="outline" size="icon" onClick={() => load(true)} disabled={loading} aria-label="Refresh">
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
          </>
        )}
        <AccountMenu me={me} onSignOut={() => api.logout().finally(onSignedOut)} />
      </header>

      {error && (
        <p role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="size-4" /> {error}
        </p>
      )}

      {settingsOpen ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Settings
            showHidden={showHidden}
            onShowHiddenChange={changeShowHidden}
            showCheckedOff={showCheckedOff}
            onShowCheckedOffChange={changeShowCheckedOff}
            columnOrder={columnOrder}
            precedence={precedence}
            onMovePrecedence={movePrecedence}
            onMoveColumn={moveColumn}
            hidden={view?.hidden ?? null}
            onHide={(item) => setHidden(item, true)}
            onUnhide={(item) => setHidden(item, false)}
          />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          {mode === "todos" && (
            <TodoBoard
              todos={todos}
              items={view?.items ?? []}
              onSave={saveTodo}
              onDelete={deleteTodo}
              onEdit={setTodoDraft}
              onOpenItem={setPreviewItem}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
            />
          )}
          {visibleColumns.map((reason, index) => {
            const { title, icon: Icon } = COLUMNS[reason];
            const items = modeItems.filter((item) => inColumn(item, reason, precedence));
            const missing = reason === "watching" ? (view?.missing ?? []) : [];
            const pending = reason === "watching" ? pendingBookmarks.filter((p) => p.type === mode) : [];
            const count = view ? items.length + missing.length + pending.length : null;
            // Boards cached before truncation was reported have no `truncated`.
            const truncated = (view?.truncated ?? []).some((t) => t.type === mode && t.reason === reason);
            const dragHandlers = {
              draggable: true as const,
              onDragStart: (e: DragEvent) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", reason);
                setDragging(reason);
              },
              onDragEnd: () => {
                setDragging(null);
                setDropTarget(null);
              },
            };
            return (
              <section
                key={reason}
                aria-label={title}
                className={cn(
                  "flex min-h-0 shrink-0 flex-col rounded-xl bg-muted/40 transition-opacity",
                  collapsed.includes(reason) ? "w-10" : "w-80",
                  dragging === reason && "opacity-50",
                  dropTarget === reason && dragging !== reason && "ring-2 ring-ring",
                )}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  setDropTarget(reason);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) moveColumn(dragging, reason);
                  setDropTarget(null);
                }}
              >
                {collapsed.includes(reason) ? (
                  <CollapsedColumn
                    title={title}
                    icon={Icon}
                    count={count}
                    onExpand={() => toggleCollapsed(reason)}
                    dragHandlers={dragHandlers}
                    className="flex-1 cursor-grab bg-transparent active:cursor-grabbing"
                  />
                ) : (
                  <>
                    <div
                      {...dragHandlers}
                      className="group/header flex cursor-grab items-center gap-2 py-2 pr-2 pl-1.5 active:cursor-grabbing"
                    >
                      <GripVertical className="size-4 text-muted-foreground/50 group-hover/header:text-muted-foreground" />
                      <Icon className="size-4 text-muted-foreground" />
                      <h2 className="text-sm font-medium">{title}</h2>
                      <span
                        className="text-sm text-muted-foreground"
                        title={truncated ? "GitHub has more; only the most recently updated are shown" : undefined}
                      >
                        {count}
                        {truncated && "+"}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={`${title} column options`}>
                            <EllipsisVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-auto min-w-40">
                          <DropdownMenuItem disabled={index === 0} onSelect={() => moveColumn(reason, visibleColumns[index - 1]!)}>
                            <ArrowLeft /> Move left
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={index === visibleColumns.length - 1}
                            onSelect={() => moveColumn(reason, visibleColumns[index + 1]!)}
                          >
                            <ArrowRight /> Move right
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => toggleCollapsed(reason)}>
                            <ChevronsRightLeft /> Collapse
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {/* Radix wraps content in a `display: table` div that grows to its widest child; block keeps cards at column width so text truncates. */}
                    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
                      {/* pt-1 leaves room for the first card's ring, which the scroll viewport would otherwise clip. */}
                      <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
                        {!view && loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
                        {view && items.length + missing.length + pending.length === 0 && (
                          <p className="px-1 py-6 text-center text-sm text-muted-foreground">Nothing here</p>
                        )}
                        {items.map((item) => (
                          <ItemCard
                            key={item.url}
                            item={item}
                            hidden={isHidden(item, hidden)}
                            onToggleWatching={() => toggleWatching(item)}
                            onHide={(item) => setHidden(item, true)}
                            onOpen={() => setPreviewItem(item)}
                            todos={openTodosFor(item)}
                            onAddTodo={() => setTodoDraft(newTodo(linkOf(item)))}
                            linked={linkedItems.get(item.url) ?? []}
                            onOpenItem={setPreviewItem}
                            checkedOff={isCheckedOff(item)}
                            onCheckOff={(checkedOff) => setCheckedOff(item, checkedOff)}
                          />
                        ))}
                        {pending.map((ref) => (
                          <PendingCard key={itemKey(ref)} bookmark={ref} />
                        ))}
                        {missing.map((ref) => (
                          <MissingCard key={itemKey(ref)} bookmark={ref} onRemove={() => removeMissing(ref)} />
                        ))}
                      </div>
                    </ScrollArea>
                  </>
                )}
              </section>
            );
          })}
        </main>
      )}
      <TodoDialog
        todo={todoDraft}
        isNew={!todos.some((t) => t.id === todoDraft?.id)}
        // Only what the board shows without the dimmed hidden items: no hidden ones, and closed ones only if enabled.
        items={(view?.items ?? []).filter((item) => !isHidden(item, hidden) && !isCheckedOff(item))}
        onSave={(todo) => {
          setTodoDraft(null);
          saveTodo(todo);
        }}
        onClose={() => setTodoDraft(null)}
      />
      <ItemPreview
        item={previewItem}
        actions={previewActions}
        todoCount={previewTodos.length}
        boardItems={view?.items ?? []}
        onOpenItem={setPreviewItem}
        todos={
          previewCurrent && (
            <ItemTodos
              todos={previewTodos}
              onSave={saveTodo}
              onDelete={deleteTodo}
              onEdit={setTodoDraft}
              onAdd={() => setTodoDraft(newTodo(linkOf(previewCurrent)))}
            />
          )
        }
        onClose={() => setPreviewItem(null)}
        onSignedOut={onSignedOut}
      />
      <Toaster />
    </div>
  );
}

function PendingCard({ bookmark }: { bookmark: MissingBookmark }) {
  return (
    <Card size="sm" className="gap-2 px-3" aria-busy="true">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{itemKey(bookmark)}</span>
        <Star className="size-4 fill-amber-400 text-amber-400" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <p className="text-xs text-muted-foreground">Loading from GitHub…</p>
    </Card>
  );
}

function MissingCard({ bookmark, onRemove }: { bookmark: MissingBookmark; onRemove: () => void }) {
  // The type is unknown; GitHub redirects /issues/N to the matching PR or discussion.
  const url = `https://github.com/${bookmark.owner}/${bookmark.repo}/issues/${bookmark.number}`;
  return (
    <Card size="sm" className="flex-row items-center gap-2 px-3">
      <div className="min-w-0 flex-1">
        <a href={url} target="_blank" rel="noreferrer" className="block truncate text-sm hover:underline">
          {itemKey(bookmark)}
        </a>
        <p className="text-xs text-destructive">Not found or no access</p>
      </div>
      <Button variant="ghost" size="icon-xs" onClick={onRemove} aria-label={`Stop watching ${itemKey(bookmark)}`}>
        <Star className="fill-amber-400 text-amber-400" />
      </Button>
    </Card>
  );
}
