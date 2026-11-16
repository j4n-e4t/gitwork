import { Button, Menu, RNHostView, ShareLink, Toolbar, ToolbarItem } from "@expo/ui/swift-ui";
import { ignoreSafeArea, navigationBarTitleDisplayMode } from "@expo/ui/swift-ui/modifiers";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchItem, type ItemDetails } from "../lib/api";
import type { ItemSummary } from "../lib/items";
import ItemView from "./item-view";

type Props = { item: ItemSummary; details: ItemDetails | null; error: string | null; onOpenItem: (item: ItemSummary) => void };

// The page under the bars. It fills the screen so it scrolls beneath the floating bar buttons and the tab bar; its
// insets (status bar plus navigation bar on top, tab bar area at the bottom) are measured here and padded in CSS.
function ItemContent({ item, details, error, onOpenItem }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <ItemView
      item={item}
      details={details}
      error={error}
      insets={{ top: insets.top, bottom: insets.bottom }}
      openItem={async (next) => onOpenItem(next)}
      // The GitHub app when it's installed, otherwise Safari.
      openUrl={async (url) => {
        await Linking.openURL(url);
      }}
      dom={{ style: { flex: 1 }, contentInsetAdjustmentBehavior: "never", automaticallyAdjustContentInsets: false }}
    />
  );
}

// An issue, PR or discussion pushed onto a tab's stack. The content is the web preview's, rendered in a web view;
// the bar and its menu are native.
export function ItemScreen({ item, onOpenItem }: { item: ItemSummary; onOpenItem: (item: ItemSummary) => void }) {
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { type, owner, repo, number } = item;

  const load = useCallback(
    () =>
      fetchItem({ type, owner, repo, number }).then(
        (next) => {
          setDetails(next);
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [type, owner, repo, number],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    // No title in the bar: the page's header already shows the title, repository and number. The content runs under
    // the navigation and tab bars, which float over it, like any iOS scroll view.
    <Toolbar modifiers={[navigationBarTitleDisplayMode("inline"), ignoreSafeArea()]}>
      <RNHostView>
        <SafeAreaProvider style={{ flex: 1 }}>
          <ItemContent item={item} details={details} error={error} onOpenItem={onOpenItem} />
        </SafeAreaProvider>
      </RNHostView>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Menu label="More" systemImage="ellipsis">
            <Button label="Open on GitHub" systemImage="safari" onPress={() => Linking.openURL(item.url)} />
            <ShareLink item={item.url} />
            <Button label="Copy Link" systemImage="doc.on.doc" onPress={() => Clipboard.setStringAsync(item.url)} />
            <Button label="Refresh" systemImage="arrow.clockwise" onPress={() => void load()} />
          </Menu>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}
