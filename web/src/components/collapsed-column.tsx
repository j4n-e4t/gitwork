import type { DragEventHandler } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  icon: LucideIcon;
  count: number | null;
  onExpand: () => void;
  className?: string;
  // Lets a collapsed item column still take part in drag-and-drop reordering.
  dragHandlers?: {
    draggable: true;
    onDragStart: DragEventHandler;
    onDragEnd: DragEventHandler;
  };
};

// A column shrunk to a narrow strip with its title running vertically; clicking it expands the column again.
export function CollapsedColumn({ title, icon: Icon, count, onExpand, className, dragHandlers }: Props) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${title} column`}
      title={`Expand ${title}`}
      {...dragHandlers}
      className={cn(
        "flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-muted/40 py-3 text-sm hover:bg-muted/70",
        className,
      )}
    >
      <Icon className="size-4 text-muted-foreground" />
      {count !== null && <span className="text-muted-foreground">{count}</span>}
      <span className="font-medium whitespace-nowrap [writing-mode:vertical-rl]">{title}</span>
    </button>
  );
}
