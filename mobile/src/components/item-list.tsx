import { Button, ContentUnavailableView, HStack, Host, Image, List, NavigationLink, NavigationStack, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  font,
  foregroundStyle,
  lineLimit,
  listStyle,
  navigationTitle,
  refreshable,
} from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps } from "react";
import type { ItemType, WorkItem } from "../lib/api";
import { age, boardColumns } from "../lib/board";
import { isSignedOut, useWork } from "../lib/work";
import { Avatar } from "./avatar";
import { useItemStack } from "./item-stack";
import { WithProfile } from "./profile";
import { ScreenState } from "./screen-state";

type SFSymbol = NonNullable<ComponentProps<typeof Image>["systemName"]>;
type Tint = "green" | "purple" | "red" | "orange" | "gray";

// SF Symbol versions of stateIcon in web/src/components/item-card.tsx.
function stateSymbol(item: WorkItem): [SFSymbol, Tint] {
  if (item.type === "discussion") {
    if (!item.closed) return ["bubble.left.and.bubble.right", "green"];
    if (item.stateReason === "RESOLVED") return ["checkmark.bubble", "purple"];
    return ["bubble.left.and.bubble.right", "gray"];
  }
  if (item.type === "issue") {
    if (item.state === "OPEN") return ["smallcircle.filled.circle", "green"];
    if (item.stateReason === "NOT_PLANNED" || item.stateReason === "DUPLICATE") return ["slash.circle", "gray"];
    return ["checkmark.circle", "purple"];
  }
  if (item.state === "MERGED") return ["arrow.triangle.merge", "purple"];
  if (item.state === "CLOSED") return ["arrow.triangle.pull", "red"];
  if (item.isDraft) return ["arrow.triangle.pull", "gray"];
  return ["arrow.triangle.pull", "green"];
}

function checksSymbol(item: WorkItem): [SFSymbol, Tint] | null {
  if (item.type !== "pr") return null;
  if (item.checks === "SUCCESS") return ["checkmark", "green"];
  if (item.checks === "FAILURE" || item.checks === "ERROR") return ["xmark", "red"];
  if (item.checks === "PENDING" || item.checks === "EXPECTED") return ["circle.fill", "orange"];
  return null;
}

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const tertiary = foregroundStyle({ type: "hierarchical", style: "tertiary" });
const caption = font({ textStyle: "caption" });

// The review decision, as the web card's badge.
function reviewBadge(item: WorkItem): [SFSymbol, string, Tint] | null {
  if (item.type !== "pr") return null;
  if (item.reviewDecision === "APPROVED") return ["checkmark.seal", "Approved", "green"];
  if (item.reviewDecision === "CHANGES_REQUESTED") return ["exclamationmark.bubble", "Changes requested", "red"];
  return null;
}

// Laid out like the web board's card (web/src/components/item-card.tsx): owner and repo on top, the title, then
// state, checks, review, discussion state and comments, with the author on the right. Pushes the item's screen.
function ItemRow({ item, value }: { item: WorkItem; value: string }) {
  const [symbol, tint] = stateSymbol(item);
  const checks = checksSymbol(item);
  const review = reviewBadge(item);
  return (
    <NavigationLink value={value}>
      <VStack alignment="leading" spacing={6}>
        <HStack spacing={6}>
          <Avatar uri={item.ownerAvatarUrl} size={18} />
          <Text modifiers={[caption, secondary, lineLimit(1)]}>{`${item.owner}/${item.repo}`}</Text>
          <Text modifiers={[caption, tertiary]}>{`#${item.number}`}</Text>
          <Spacer />
          <Text modifiers={[caption, tertiary]}>{age(item.updatedAt)}</Text>
        </HStack>
        <Text modifiers={[font({ textStyle: "body", weight: "medium" }), lineLimit(3)]}>{item.title}</Text>
        <HStack spacing={8}>
          <Image systemName={symbol} size={13} modifiers={[foregroundStyle(tint)]} />
          {checks && <Image systemName={checks[0]} size={12} modifiers={[foregroundStyle(checks[1])]} />}
          {review && (
            <HStack spacing={3}>
              <Image systemName={review[0]} size={11} modifiers={[foregroundStyle(review[2])]} />
              <Text modifiers={[caption, foregroundStyle(review[2]), lineLimit(1)]}>{review[1]}</Text>
            </HStack>
          )}
          {item.type === "discussion" && <Text modifiers={[caption, secondary, lineLimit(1)]}>{item.category}</Text>}
          {item.type === "discussion" && item.isAnswered === true && <Text modifiers={[caption, foregroundStyle("green")]}>Answered</Text>}
          {item.type === "discussion" && item.isAnswered === false && !item.closed && (
            <Text modifiers={[caption, foregroundStyle("orange")]}>Unanswered</Text>
          )}
          {item.comments > 0 && (
            <HStack spacing={3}>
              <Image systemName="bubble.right" size={11} modifiers={[secondary]} />
              <Text modifiers={[caption, secondary]}>{String(item.comments)}</Text>
            </HStack>
          )}
          <Spacer />
          {item.author && (
            <HStack spacing={5}>
              <Avatar uri={item.authorAvatarUrl} size={16} />
              <Text modifiers={[caption, secondary, lineLimit(1)]}>{item.author}</Text>
            </HStack>
          )}
        </HStack>
      </VStack>
    </NavigationLink>
  );
}

// One tab: the board's columns for an item type as list sections, in the saved order and precedence.
export function ItemList({ type, title, emptyText }: { type: ItemType; title: string; emptyText: string }) {
  const { view, error, refresh } = useWork();
  const columns = view ? boardColumns(view, type) : [];
  const stack = useItemStack();

  let content;
  if (!view || isSignedOut(error)) content = <ScreenState title={title} />;
  else if (columns.length === 0) {
    content = (
      <ContentUnavailableView
        title={emptyText}
        systemImage="tray"
        actions={<Button label="Refresh" onPress={refresh} modifiers={[buttonStyle("glass")]} />}
        modifiers={[navigationTitle(title)]}
      />
    );
  } else {
    content = (
      <List modifiers={[listStyle("insetGrouped"), navigationTitle(title), refreshable(refresh)]}>
        {columns.map((column) => (
          <Section
            key={column.reason}
            header={
              <HStack>
                <Text>{column.title}</Text>
                <Spacer />
                <Text>{String(column.items.length)}</Text>
              </HStack>
            }
          >
            {column.items.map((item) => (
              <ItemRow key={item.url} item={item} value={stack.link(item)} />
            ))}
          </Section>
        ))}
      </List>
    );
  }

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack path={stack.path} onPathChange={stack.setPath}>
        <WithProfile>{content}</WithProfile>
        {stack.destinations}
      </NavigationStack>
    </Host>
  );
}
