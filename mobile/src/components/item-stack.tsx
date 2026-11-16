import { NavigationDestination } from "@expo/ui/swift-ui";
import { useCallback, useState } from "react";
import { itemPath, type ItemSummary } from "../lib/items";
import { ItemScreen } from "./item-screen";

// The item each stack value stands for, shared by all tabs. The latest copy wins, so a refreshed board updates it.
const summaries = new Map<string, ItemSummary>();

const link = (item: ItemSummary) => {
  const value = itemPath(item);
  summaries.set(value, item);
  return value;
};

// A tab's navigation stack of item screens. Rows link with `link(item)`; links inside an item push with `open`.
export function useItemStack() {
  const [path, setPath] = useState<string[]>([]);

  const open = useCallback((item: ItemSummary) => setPath((current) => [...current, link(item)]), []);

  // One destination per value on the stack, built on demand.
  const destinations = [...new Set(path)].map((value) => {
    const item = summaries.get(value);
    return (
      item && (
        <NavigationDestination key={value} value={value}>
          <ItemScreen item={item} onOpenItem={open} />
        </NavigationDestination>
      )
    );
  });

  return { path, setPath, link, open, destinations };
}
