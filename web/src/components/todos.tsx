import { useState, type FormEvent } from "react";
import {
  CalendarClock,
  CalendarX,
  Check,
  ChevronsRightLeft,
  ChevronsUpDown,
  CircleCheck,
  EllipsisVertical,
  Inbox,
  Link2,
  ListPlus,
  Pencil,
  Sun,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { CollapsedColumn } from "@/components/collapsed-column";
import { stateIcon } from "@/components/item-card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { itemKey, sameItem, type Todo, type TodoLink, type WorkItem } from "@/lib/api";
import { MODES } from "@/lib/board";
import { cn } from "@/lib/utils";

// Deadlines are calendar dates in the viewer's time zone, compared as "YYYY-MM-DD" strings.
export function localDate(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const daysUntil = (deadline: string) =>
  Math.round((Date.parse(`${deadline}T00:00:00`) - Date.parse(`${localDate()}T00:00:00`)) / 86_400_000);

export function deadlineLabel(deadline: string): { label: string; className: string } {
  const days = daysUntil(deadline);
  const date = new Date(`${deadline}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days < 0) return { label: `${date} · ${-days}d overdue`, className: "text-red-400" };
  if (days === 0) return { label: "Today", className: "text-amber-400" };
  if (days === 1) return { label: "Tomorrow", className: "text-foreground" };
  return { label: days < 7 ? `${date} · in ${days}d` : date, className: "text-muted-foreground" };
}

export const newTodo = (link: TodoLink | null = null): Todo => ({
  id: crypto.randomUUID(),
  title: "",
  deadline: null,
  done: false,
  link,
  createdAt: new Date().toISOString(),
});

export const linkOf = (item: WorkItem): TodoLink => ({
  type: item.type,
  owner: item.owner,
  repo: item.repo,
  number: item.number,
  title: item.title,
});

type Bucket = "overdue" | "today" | "upcoming" | "someday" | "done";

const BUCKETS: { bucket: Bucket; title: string; icon: LucideIcon }[] = [
  { bucket: "overdue", title: "Overdue", icon: CalendarX },
  { bucket: "today", title: "Today", icon: Sun },
  { bucket: "upcoming", title: "Upcoming", icon: CalendarClock },
  { bucket: "someday", title: "No deadline", icon: Inbox },
  { bucket: "done", title: "Done", icon: CircleCheck },
];

function bucketOf(todo: Todo): Bucket {
  if (todo.done) return "done";
  if (!todo.deadline) return "someday";
  const days = daysUntil(todo.deadline);
  return days < 0 ? "overdue" : days === 0 ? "today" : "upcoming";
}

// Soonest deadline first; undated todos keep creation order.
const byDeadline = (a: Todo, b: Todo) =>
  (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.createdAt.localeCompare(b.createdAt);

type BoardProps = {
  todos: Todo[];
  items: WorkItem[];
  onSave: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  onEdit: (todo: Todo) => void;
  onOpenItem: (item: WorkItem) => void;
  collapsed: string[];
  onToggleCollapsed: (key: string) => void;
};

export function TodoBoard({ todos, items, onSave, onDelete, onEdit, onOpenItem, collapsed, onToggleCollapsed }: BoardProps) {
  return (
    <>
      {BUCKETS.map(({ bucket, title, icon: Icon }) => {
        const inBucket = todos.filter((t) => bucketOf(t) === bucket).sort(byDeadline);
        if (bucket === "done") inBucket.reverse();
        const key = `todo:${bucket}`;
        if (collapsed.includes(key)) {
          return (
            <CollapsedColumn key={bucket} title={title} icon={Icon} count={inBucket.length} onExpand={() => onToggleCollapsed(key)} />
          );
        }
        return (
          <section key={bucket} aria-label={title} className="flex min-h-0 w-80 shrink-0 flex-col rounded-xl bg-muted/40">
            <div className="flex items-center gap-2 py-2 pr-2 pl-3">
              <Icon className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">{title}</h2>
              <span className="text-sm text-muted-foreground">{inBucket.length}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                onClick={() => onToggleCollapsed(key)}
                aria-label={`Collapse ${title} column`}
                title="Collapse"
              >
                <ChevronsRightLeft />
              </Button>
            </div>
            {/* Same table-wrapper override as the item columns, so cards keep the column width. */}
            <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
              <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
                {inBucket.length === 0 && <p className="px-1 py-6 text-center text-sm text-muted-foreground">Nothing here</p>}
                {inBucket.map((todo) => (
                  <TodoCard
                    key={todo.id}
                    todo={todo}
                    item={todo.link ? items.find((i) => sameItem(i, todo.link!) && i.type === todo.link!.type) : undefined}
                    onToggleDone={() => onSave({ ...todo, done: !todo.done })}
                    onEdit={() => onEdit(todo)}
                    onDelete={() => onDelete(todo)}
                    onOpenItem={onOpenItem}
                  />
                ))}
              </div>
            </ScrollArea>
          </section>
        );
      })}
    </>
  );
}

type ItemTodosProps = {
  todos: Todo[];
  onSave: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  onEdit: (todo: Todo) => void;
  onAdd: () => void;
};

// The open todos linked to one item, for its preview dialog.
export function ItemTodos({ todos, onSave, onDelete, onEdit, onAdd }: ItemTodosProps) {
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      {todos.length === 0 && <p className="text-muted-foreground">No open todos for this item.</p>}
      {todos.toSorted(byDeadline).map((todo) => (
        <TodoCard
          key={todo.id}
          todo={todo}
          item={undefined}
          onToggleDone={() => onSave({ ...todo, done: !todo.done })}
          onEdit={() => onEdit(todo)}
          onDelete={() => onDelete(todo)}
        />
      ))}
      <Button variant="outline" size="sm" className="self-start" onClick={onAdd}>
        <ListPlus /> Add todo
      </Button>
    </div>
  );
}

type CardProps = {
  todo: Todo;
  // The linked item when it's currently on the board, for its live title and state.
  item: WorkItem | undefined;
  onToggleDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  // Omitted where the linked item is already in view, which hides the link.
  onOpenItem?: (item: WorkItem) => void;
};

function TodoCard({ todo, item, onToggleDone, onEdit, onDelete, onOpenItem }: CardProps) {
  const deadline = todo.deadline && deadlineLabel(todo.deadline);
  return (
    <Card size="sm" className="gap-2 px-3">
      <div className="flex items-start gap-2">
        <Checkbox
          checked={todo.done}
          onCheckedChange={onToggleDone}
          className="mt-0.5"
          aria-label={todo.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}
        />
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            "min-w-0 flex-1 text-left text-sm font-medium leading-snug [overflow-wrap:anywhere] hover:underline",
            todo.done && "text-muted-foreground line-through",
          )}
        >
          {todo.title}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`More actions for "${todo.title}"`}>
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {deadline && !todo.done && (
        <p className={cn("flex items-center gap-1.5 pl-6 text-xs", deadline.className)}>
          <CalendarClock className="size-3.5" /> {deadline.label}
        </p>
      )}
      {todo.link && onOpenItem && <LinkedItem link={todo.link} item={item} onOpenItem={onOpenItem} />}
    </Card>
  );
}

function LinkedItem({ link, item, onOpenItem }: { link: TodoLink; item: WorkItem | undefined; onOpenItem: (item: WorkItem) => void }) {
  const url = `https://github.com/${link.owner}/${link.repo}/${{ pr: "pull", issue: "issues", discussion: "discussions" }[link.type]}/${link.number}`;
  const [StateIcon, stateClass] = item ? stateIcon(item) : [Link2, "text-muted-foreground"];
  return (
    <a
      href={item?.url ?? url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // Preview items that are on the board; others just open GitHub.
        if (!item || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpenItem(item);
      }}
      className="group/link ml-6 flex min-w-0 flex-col gap-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <OwnerAvatar owner={link.owner} src={item?.ownerAvatarUrl} className="size-4" />
        <StateIcon className={cn("size-3.5 shrink-0", stateClass)} />
        <span className="truncate">{itemKey(link)}</span>
      </span>
      <span className="leading-snug text-foreground [overflow-wrap:anywhere] group-hover/link:underline">
        {item?.title ?? link.title}
      </span>
    </a>
  );
}

type DialogProps = {
  // The todo being created or edited; null closes the dialog.
  todo: Todo | null;
  isNew: boolean;
  items: WorkItem[];
  onSave: (todo: Todo) => void;
  onClose: () => void;
};

export function TodoDialog({ todo, isNew, items, onSave, onClose }: DialogProps) {
  return (
    <Dialog open={todo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {/* Keyed so reopening starts from the todo's saved values, not the last edit. */}
        {todo && <TodoForm key={todo.id} todo={todo} isNew={isNew} items={items} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function TodoForm({ todo, isNew, items, onSave }: Omit<DialogProps, "todo" | "onClose"> & { todo: Todo }) {
  const [title, setTitle] = useState(todo.title);
  const [deadline, setDeadline] = useState(todo.deadline ?? "");
  const [link, setLink] = useState(todo.link);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({ ...todo, title: title.trim(), deadline: deadline || null, link });
  }

  // min-w-0: DialogContent is a grid, and a long linked-item title would otherwise widen the form past the dialog.
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{isNew ? "New todo" : "Edit todo"}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="todo-title">Task</Label>
        <Input id="todo-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} required autoFocus />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="todo-deadline">Deadline</Label>
        <div className="flex gap-2">
          <Input
            id="todo-deadline"
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-auto [color-scheme:dark]"
          />
          {deadline && (
            <Button type="button" variant="ghost" onClick={() => setDeadline("")}>
              <X /> No deadline
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Linked item</Label>
        <ItemPicker items={items} value={link} onChange={setLink} />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!title.trim()}>
          {isNew ? "Add todo" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ItemPicker({ items, value, onChange }: { items: WorkItem[]; value: TodoLink | null; onChange: (link: TodoLink | null) => void }) {
  const [open, setOpen] = useState(false);
  const select = (link: TodoLink | null) => {
    onChange(link);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full min-w-0 justify-between font-normal">
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <OwnerAvatar owner={value.owner} />
              <span className="truncate">
                {itemKey(value)} {value.title}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search items on the board…" />
          <CommandList>
            <CommandEmpty>No matching items.</CommandEmpty>
            {value && (
              <CommandGroup>
                <CommandItem value="__none" onSelect={() => select(null)}>
                  <X /> Remove link
                </CommandItem>
              </CommandGroup>
            )}
            {MODES.map(({ value: type, label }) => {
              const ofType = items.filter((i) => i.type === type);
              if (!ofType.length) return null;
              return (
                <CommandGroup key={type} heading={label}>
                  {ofType.map((item) => {
                    const [StateIcon, stateClass] = stateIcon(item);
                    const selected = value !== null && sameItem(value, item) && value.type === item.type;
                    return (
                      <CommandItem key={item.url} value={`${itemKey(item)} ${item.title}`} onSelect={() => select(linkOf(item))}>
                        <OwnerAvatar owner={item.owner} src={item.ownerAvatarUrl} />
                        <StateIcon className={stateClass} />
                        <span className="shrink-0 text-muted-foreground">{itemKey(item)}</span>
                        <span className="truncate">{item.title}</span>
                        {selected && <Check className="ml-auto" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// GitHub serves any user's or org's avatar at /<owner>.png, which covers links to items no longer on the board.
function OwnerAvatar({
  owner,
  src = `https://github.com/${owner}.png?size=40`,
  className = "size-5",
}: {
  owner: string;
  src?: string;
  className?: string;
}) {
  return (
    <Avatar className={className}>
      <AvatarImage src={src} alt="" />
      <AvatarFallback>{owner[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
