import {
  inColumn,
  reasonApplies,
  resolveReasonOrder,
  type ItemType,
  type Reason,
  type WorkItem,
  type WorkView,
} from "../../../server/types.ts";

// Same titles as the web board's columns (web/src/lib/board.ts).
const COLUMN_TITLES: Record<Reason, string> = {
  authored: "Authored",
  review: "Review requested",
  assigned: "Assigned",
  mentioned: "Mentioned",
  commented: "Commented",
  watching: "Watching",
};

export type Column = { reason: Reason; title: string; items: WorkItem[] };

// The web board's columns for one item type, as list sections: the saved column order, each item only under its
// highest-precedence reason. Empty columns are dropped. The server already left out hidden and checked-off items.
export function boardColumns(view: WorkView, type: ItemType): Column[] {
  const precedence = resolveReasonOrder(view.precedence);
  const items = view.items.filter((item) => item.type === type);
  return resolveReasonOrder(view.columnOrder)
    .filter((reason) => reasonApplies(reason, type))
    .map((reason) => ({ reason, title: COLUMN_TITLES[reason], items: items.filter((item) => inColumn(item, reason, precedence)) }))
    .filter((column) => column.items.length > 0);
}

export function age(iso: string) {
  const minutes = (Date.now() - Date.parse(iso)) / 60_000;
  if (minutes < 60) return `${Math.max(Math.round(minutes), 1)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}
