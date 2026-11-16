import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  FileDiff,
  FileInput,
  FileMinus,
  FilePlus,
  Rows2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { relativeTime } from "@/components/item-card";
import { UserLink } from "@/components/user-link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, UnauthorizedError, type Commit, type CommitList, type Diff, type DiffFile, type WorkItem } from "@/lib/api";
import { highlightLines, type Token } from "@/lib/highlight";
import { cn } from "@/lib/utils";

// Fetched commits and diffs for the session, like the preview's details cache. The preview's refresh button
// forgets a PR's entries and bumps `generation`, which re-fetches whatever is on screen.
const cache = new Map<string, unknown>();

export function forgetChanges(pr: WorkItem) {
  for (const key of cache.keys()) if (key.startsWith(`${pr.url} `)) cache.delete(key);
}

function useFetched<T>(key: string, load: () => Promise<T>, generation: number, onSignedOut: () => void) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    const cached = cache.get(key) as T | undefined;
    if (cached) {
      setState({ key, data: cached });
      return;
    }
    let current = true;
    setState(null);
    load().then(
      (data) => {
        cache.set(key, data);
        if (current) setState({ key, data });
      },
      (e) => {
        if (e instanceof UnauthorizedError) onSignedOut();
        else if (current) setState({ key, error: (e as Error).message });
      },
    );
    return () => {
      current = false;
    };
    // `load` is recreated each render; the key identifies what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation, onSignedOut]);
  return state?.key === key ? state : null;
}

type Props = { pr: WorkItem; generation: number; onSignedOut: () => void };

/** One of a PR's commits with its diff, and Prev/Next through the PR's other commits. onSelect(null) goes back. */
export function CommitDiff({ pr, sha, onSelect, generation, onSignedOut }: Props & { sha: string; onSelect: (sha: string | null) => void }) {
  const state = useFetched<CommitList>(`${pr.url} commits`, () => api.commits(pr), generation, onSignedOut);
  if (!state) return <LoadingRows />;
  if (state.error) return <ErrorLine message={state.error} />;
  const { commits } = state.data!;
  const index = commits.findIndex((c) => c.sha === sha);
  if (index < 0) {
    // Gone after a force-push, or past the 250 commits GitHub lists.
    return (
      <div className="space-y-3 p-4">
        <BackButton onClick={() => onSelect(null)} />
        <p className="text-muted-foreground">This commit isn't among the PR's current commits.</p>
      </div>
    );
  }
  return (
    <CommitView
      pr={pr}
      commit={commits[index]!}
      previous={commits[index - 1]}
      next={commits[index + 1]}
      onSelect={onSelect}
      generation={generation}
      onSignedOut={onSignedOut}
    />
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <ArrowLeft /> History
    </Button>
  );
}

function CommitAuthor({ commit }: { commit: Commit }) {
  if (commit.author) return <UserLink user={commit.author} />;
  return (
    <span className="flex items-center gap-1.5">
      <Avatar className="size-5">
        <AvatarFallback className="text-[0.625rem]">{commit.authorName[0]?.toUpperCase()}</AvatarFallback>
      </Avatar>
      {commit.authorName}
    </span>
  );
}

function copySha(sha: string) {
  navigator.clipboard.writeText(sha).then(
    () => toast.success("SHA copied"),
    () => toast.error("Couldn't copy the SHA"),
  );
}

function ShaButton({ commit, className }: { commit: Commit; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <Button variant="ghost" size="icon-xs" onClick={() => copySha(commit.sha)} aria-label="Copy full SHA" title="Copy full SHA">
        <Copy />
      </Button>
      <a href={commit.url} target="_blank" rel="noreferrer" className="rounded px-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        {commit.sha.slice(0, 7)}
      </a>
    </span>
  );
}

function CommitView({
  pr,
  commit,
  previous,
  next,
  onSelect,
  generation,
  onSignedOut,
}: Props & { commit: Commit; previous?: Commit; next?: Commit; onSelect: (sha: string | null) => void }) {
  const state = useFetched<Diff>(`${pr.url} diff ${commit.sha}`, () => api.diff(pr, commit.sha), generation, onSignedOut);
  const [headline, ...rest] = commit.message.split("\n");
  const body = rest.join("\n").trim();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 px-4 pt-4">
        <div className="flex items-center gap-1">
          <BackButton onClick={() => onSelect(null)} />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={!previous} onClick={() => previous && onSelect(previous.sha)}>
              <ChevronLeft /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={!next} onClick={() => next && onSelect(next.sha)}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <div className="space-y-2 px-3 py-2">
            <p className="font-medium [overflow-wrap:anywhere]">{headline}</p>
            {body && <pre className="max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">{body}</pre>}
          </div>
          <div className="flex items-center gap-1.5 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <CommitAuthor commit={commit} />
            <span title={new Date(commit.authoredAt).toLocaleString()}>committed {relativeTime(commit.authoredAt)} ago</span>
            <ShaButton commit={commit} className="ml-auto" />
          </div>
        </div>
      </div>
      {!state ? <LoadingRows /> : state.error ? <ErrorLine message={state.error} /> : <DiffViewer diff={state.data!} moreUrl={commit.url} />}
    </div>
  );
}

export function FilesTab({ pr, generation, onSignedOut }: Props) {
  const state = useFetched<Diff>(`${pr.url} diff`, () => api.diff(pr), generation, onSignedOut);
  if (!state) return <LoadingRows />;
  if (state.error) return <ErrorLine message={state.error} />;
  return <DiffViewer diff={state.data!} moreUrl={`${pr.url}/files`} />;
}

type Layout = "unified" | "split";
// Files with more changed lines than this start collapsed, as on GitHub.
const LARGE_DIFF = 400;

function DiffViewer({ diff: { files, truncated }, moreUrl }: { diff: Diff; moreUrl: string }) {
  const [layout, setLayout] = useState<Layout>("unified");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(files.filter((f) => f.additions + f.deletions > LARGE_DIFF).map((f) => f.path)));
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const toggle = (path: string, open?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open ?? next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const pane = useRef<HTMLDivElement>(null);
  // Scrolls only the diff pane. scrollIntoView would also scroll the dialog's overflow-hidden columns when the pane
  // can't scroll far enough (the last files), shifting the toolbar out of view.
  const jumpTo = (path: string) => {
    toggle(path, true);
    const target = document.getElementById(fileId(path));
    if (!pane.current || !target) return;
    pane.current.scrollTop += target.getBoundingClientRect().top - pane.current.getBoundingClientRect().top;
  };

  if (files.length === 0) return <p className="p-4 text-muted-foreground">No files changed.</p>;
  return (
    // Fills the tab, or what's left under a commit's header: the toolbar stays put while the file list and the
    // diffs scroll on their own.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-3">
        <span className="text-muted-foreground">
          {files.length}
          {truncated && "+"} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="text-emerald-400">+{additions}</span>
        <span className="text-red-400">−{deletions}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(collapsed.size === files.length ? new Set() : new Set(files.map((f) => f.path)))}
          >
            {collapsed.size === files.length ? <ChevronsUpDown /> : <ChevronsDownUp />}
            {collapsed.size === files.length ? "Expand all" : "Collapse all"}
          </Button>
          <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && setLayout(v as Layout)}>
            <ToggleGroupItem value="unified" aria-label="Unified diff" title="Unified">
              <Rows2 />
            </ToggleGroupItem>
            <ToggleGroupItem value="split" aria-label="Split diff" title="Split">
              <Columns2 />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-start gap-4 px-4 pb-4">
        <FileList files={files} onJump={jumpTo} />
        <div ref={pane} className="max-h-full min-w-0 flex-1 space-y-3 self-stretch overflow-y-auto">
          {files.map((file) => (
            <FileView key={file.path} file={file} layout={layout} collapsed={collapsed.has(file.path)} onToggle={() => toggle(file.path)} />
          ))}
          {truncated && (
            <a href={moreUrl} target="_blank" rel="noreferrer" className="inline-block text-muted-foreground hover:underline">
              Showing the first {files.length} files · see the rest on GitHub
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const fileId = (path: string) => `diff-${path}`;

const STATUS_ICONS: Record<DiffFile["status"], [LucideIcon, string, string]> = {
  added: [FilePlus, "text-emerald-400", "Added"],
  removed: [FileMinus, "text-red-400", "Deleted"],
  renamed: [FileInput, "text-sky-400", "Renamed"],
  copied: [FileInput, "text-sky-400", "Copied"],
  modified: [FileDiff, "text-amber-400", "Modified"],
  changed: [FileDiff, "text-amber-400", "Changed"],
  unchanged: [FileDiff, "text-muted-foreground", "Unchanged"],
};

// The files' sidebar, as tall as its list up to the pane's height, then scrolling. Hidden on narrow screens, where
// the diffs need the width.
function FileList({ files, onJump }: { files: DiffFile[]; onJump: (path: string) => void }) {
  return (
    <nav aria-label="Changed files" className="hidden max-h-full w-64 shrink-0 overflow-y-auto rounded-lg border bg-card p-1 lg:block">
      <ul>
        {files.map((file) => {
          const [Icon, color, label] = STATUS_ICONS[file.status];
          const slash = file.path.lastIndexOf("/");
          return (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onJump(file.path)}
                title={file.path}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
              >
                <Icon className={cn("size-3.5 shrink-0", color)} aria-label={label} />
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                  {file.path.slice(slash + 1)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function FileView({ file, layout, collapsed, onToggle }: { file: DiffFile; layout: Layout; collapsed: boolean; onToggle: () => void }) {
  const [Icon, color, label] = STATUS_ICONS[file.status];
  const hunks = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const tokens = useHighlighted(file.path, hunks, !collapsed);
  return (
    <section id={fileId(file.path)} className="overflow-clip rounded-lg border bg-card">
      {/* Sticks to the top of the diff pane while its diff is on screen, like GitHub's file headers. It's square and
          the section clips to its rounded border (overflow-clip, which unlike hidden doesn't break sticky), so rows
          scrolling under it can't show through rounded corners. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn("sticky top-0 z-10 flex w-full items-center gap-2 bg-popover px-3 py-2 text-left hover:bg-muted", !collapsed && "border-b")}
      >
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", collapsed && "-rotate-90")} />
        <Icon className={cn("size-4 shrink-0", color)} aria-label={label} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.previousPath && file.previousPath !== file.path && <span className="text-muted-foreground">{file.previousPath} → </span>}
          {file.path}
        </span>
        <span className="shrink-0 text-xs text-emerald-400">+{file.additions}</span>
        <span className="shrink-0 text-xs text-red-400">−{file.deletions}</span>
        <ChangeBar additions={file.additions} deletions={file.deletions} />
      </button>
      {!collapsed &&
        (hunks.length === 0 ? (
          <p className="px-3 py-3 text-muted-foreground">
            {file.patch === null
              ? "Binary file or diff too large to show."
              : file.status === "renamed"
                ? "File renamed without changes."
                : "No changes to show."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>{layout === "unified" ? <UnifiedRows hunks={hunks} tokens={tokens} /> : <SplitRows hunks={hunks} tokens={tokens} />}</tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

// GitHub's five-square summary of a file's additions and deletions.
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const added = total === 0 ? 0 : Math.round((additions / total) * 5);
  const deleted = total === 0 ? 0 : Math.min(5 - added, Math.round((deletions / total) * 5));
  return (
    <span className="hidden shrink-0 gap-px sm:flex" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn("size-2 rounded-[1px]", i < added ? "bg-emerald-400" : i < added + deleted ? "bg-red-400" : "bg-muted")} />
      ))}
    </span>
  );
}

type Line = { kind: "add" | "del" | "ctx"; old: number | null; new: number | null; text: string };
type Hunk = { header: string; lines: Line[] };

// Splits a unified diff (GitHub's `patch`, which starts at the first @@ header) into hunks with line numbers.
function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunks.push({ header: raw, lines: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    // "\ No newline at end of file" is a marker about the previous line, not content; an empty context line is " ".
    if (!hunk || raw === "" || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) hunk.lines.push({ kind: "add", old: null, new: newLine++, text: raw.slice(1) });
    else if (raw.startsWith("-")) hunk.lines.push({ kind: "del", old: oldLine++, new: null, text: raw.slice(1) });
    else hunk.lines.push({ kind: "ctx", old: oldLine++, new: newLine++, text: raw.slice(1) });
  }
  return hunks;
}

type LineTokens = ReadonlyMap<Line, Token[]>;

// Syntax tokens per line, once the file is expanded. Each hunk's old side (context and deletions) and new side
// (context and additions) are highlighted as continuous code, so constructs spanning lines, like block comments,
// color correctly within a hunk. Lines show as plain text until then, or for languages Shiki doesn't know.
function useHighlighted(path: string, hunks: Hunk[], enabled: boolean): LineTokens {
  const [tokens, setTokens] = useState<LineTokens>(new Map());
  useEffect(() => {
    if (!enabled || hunks.length === 0) return;
    let current = true;
    const sides = hunks.flatMap((hunk) => [hunk.lines.filter((l) => l.kind !== "add"), hunk.lines.filter((l) => l.kind !== "del")]);
    Promise.all(sides.map((lines) => highlightLines(path, lines.map((l) => l.text).join("\n"))))
      .then((results) => {
        if (!current) return;
        const next = new Map<Line, Token[]>();
        // The new side comes second, so context lines end up with its tokens.
        sides.forEach((lines, i) => lines.forEach((line, j) => results[i]?.[j] && next.set(line, results[i]![j]!)));
        setTokens(next);
      })
      .catch((error) => console.error("Highlighting failed", error));
    return () => {
      current = false;
    };
  }, [path, hunks, enabled]);
  return tokens;
}

const LINE_BG: Record<Line["kind"], string> = { add: "bg-emerald-500/10", del: "bg-red-500/10", ctx: "" };
const NUMBER_BG: Record<Line["kind"], string> = { add: "bg-emerald-500/15", del: "bg-red-500/15", ctx: "" };
const MARKER: Record<Line["kind"], string> = { add: "+", del: "-", ctx: " " };

function LineNumber({ value, kind }: { value: number | null; kind: Line["kind"] | null }) {
  return (
    <td className={cn("w-px min-w-10 px-2 text-right align-top whitespace-nowrap text-muted-foreground select-none", kind && NUMBER_BG[kind])}>{value}</td>
  );
}

function Code({ line, tokens, className }: { line: Line | null; tokens: LineTokens; className?: string }) {
  if (!line) return <td className={cn("bg-muted/40", className)} />;
  return (
    <td className={cn("px-2 align-top whitespace-pre-wrap [overflow-wrap:anywhere]", LINE_BG[line.kind], className)}>
      <span className="text-muted-foreground select-none">{MARKER[line.kind]}</span>
      {tokens.get(line)?.map((token, i) => (
        <span
          key={i}
          style={{ color: token.color }}
          // Shiki's FontStyle flags: 1 italic, 2 bold, 4 underline.
          className={cn(token.fontStyle && token.fontStyle & 1 && "italic", token.fontStyle && token.fontStyle & 2 && "font-bold")}
        >
          {token.content}
        </span>
      )) ?? line.text}
    </td>
  );
}

function HunkHeader({ header, colSpan }: { header: string; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="bg-sky-500/10 px-2 py-0.5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
        {header}
      </td>
    </tr>
  );
}

function UnifiedRows({ hunks, tokens }: { hunks: Hunk[]; tokens: LineTokens }) {
  return hunks.map((hunk, h) => (
    <Fragment key={h}>
      <HunkHeader header={hunk.header} colSpan={3} />
      {hunk.lines.map((line, i) => (
        <tr key={i}>
          <LineNumber value={line.old} kind={line.kind} />
          <LineNumber value={line.new} kind={line.kind} />
          <Code line={line} tokens={tokens} />
        </tr>
      ))}
    </Fragment>
  ));
}

// Side by side: context on both sides, and each run of deletions paired row by row with the additions after it.
function SplitRows({ hunks, tokens }: { hunks: Hunk[]; tokens: LineTokens }) {
  return hunks.map((hunk, h) => {
    const rows: [Line | null, Line | null][] = [];
    for (let i = 0; i < hunk.lines.length; ) {
      const line = hunk.lines[i]!;
      if (line.kind === "ctx") {
        rows.push([line, line]);
        i++;
        continue;
      }
      const dels: Line[] = [];
      const adds: Line[] = [];
      while (hunk.lines[i]?.kind === "del") dels.push(hunk.lines[i++]!);
      while (hunk.lines[i]?.kind === "add") adds.push(hunk.lines[i++]!);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) rows.push([dels[j] ?? null, adds[j] ?? null]);
    }
    return (
      <Fragment key={h}>
        <HunkHeader header={hunk.header} colSpan={4} />
        {rows.map(([left, right], i) => (
          <tr key={i}>
            <LineNumber value={left?.old ?? null} kind={left?.kind ?? null} />
            <Code line={left} tokens={tokens} className="w-1/2 border-r" />
            <LineNumber value={right?.new ?? null} kind={right?.kind ?? null} />
            <Code line={right} tokens={tokens} className="w-1/2" />
          </tr>
        ))}
      </Fragment>
    );
  });
}

function LoadingRows() {
  return (
    <div className="space-y-3 p-4" aria-label="Loading">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-center gap-2 p-4 text-destructive">
      <TriangleAlert className="size-4" /> {message}
    </p>
  );
}
