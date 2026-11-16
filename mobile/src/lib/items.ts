import { itemKey, type ItemType, type LinkedItem, type ReferencedItem, type WorkItem } from "../../../server/types.ts";

// What the item screen needs before its details load: enough to fetch them and show the title and state. Board
// items carry the most; links and resolved references carry their state; an unresolved reference has none.
export type ItemSummary = WorkItem | LinkedItem | ReferencedItem | { type: ItemType; owner: string; repo: string; number: number; title: string; url: string };

const URL_PATHS: Record<ItemType, string> = { pr: "pull", issue: "issues", discussion: "discussions" };

export const itemUrl = (item: { type: ItemType; owner: string; repo: string; number: number }) =>
  `https://github.com/${item.owner}/${item.repo}/${URL_PATHS[item.type]}/${item.number}`;

// The value an item screen is pushed with on a tab's navigation stack.
export const itemPath = (item: { type: ItemType; owner: string; repo: string; number: number }) => `${item.type}:${itemKey(item)}`;
