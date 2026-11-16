import {
  BottomSheet,
  Button,
  Form,
  HStack,
  Label,
  NavigationStack,
  Section,
  Spacer,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import { buttonStyle, font, foregroundStyle, navigationBarTitleDisplayMode, navigationTitle } from "@expo/ui/swift-ui/modifiers";
import { useState, type ComponentProps, type ReactNode } from "react";
import { API_URL, type HiddenItem } from "../lib/api";
import { useWork } from "../lib/work";
import { Avatar } from "./avatar";

type SFSymbol = NonNullable<ComponentProps<typeof Label>["systemImage"]>;

// Same groups as the web settings' Hidden section.
const HIDDEN_KINDS: { kind: HiddenItem["kind"]; title: string; symbol: SFSymbol }[] = [
  { kind: "owner", title: "Owners", symbol: "person.2" },
  { kind: "repo", title: "Repositories", symbol: "book.closed" },
  { kind: "pr", title: "Items", symbol: "number" },
  { kind: "author", title: "Authors", symbol: "person" },
];

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

// Wraps a tab's root screen to add the profile button to its bar, which opens Settings.
export function WithProfile({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Toolbar>
      {children}
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <BottomSheet
            isPresented={open}
            onIsPresentedChange={setOpen}
            anchor={<Button systemImage="person.crop.circle" label="Profile and Settings" onPress={() => setOpen(true)} />}
          >
            <SettingsSheet onDone={() => setOpen(false)} />
          </BottomSheet>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}

function SettingsSheet({ onDone }: { onDone: () => void }) {
  const { me, view, unhide, signOut } = useWork();
  const hidden = view?.hidden ?? [];
  const [error, setError] = useState<string | null>(null);

  const onUnhide = (item: HiddenItem) => {
    setError(null);
    unhide(item).catch((err: Error) => setError(`Couldn't unhide ${item.key}: ${err.message}`));
  };

  return (
    <NavigationStack>
      <Toolbar>
        <Form modifiers={[navigationTitle("Settings"), navigationBarTitleDisplayMode("inline")]}>
          {me && (
            <Section>
              <HStack spacing={12}>
                <Avatar uri={me.avatarUrl} size={52} />
                <VStack alignment="leading" spacing={2}>
                  <Text modifiers={[font({ textStyle: "headline" })]}>{me.login}</Text>
                  <Text modifiers={[font({ textStyle: "subheadline" }), secondary]}>Signed in with GitHub</Text>
                </VStack>
                <Spacer />
              </HStack>
            </Section>
          )}
          <Section
            title="Hidden"
            footer={
              <Text>
                {error ?? "Hidden owners, repositories, items and authors are left out on every device. Hide them from a card's menu on the web board."}
              </Text>
            }
          >
            {hidden.length === 0 && <Text modifiers={[secondary]}>Nothing hidden.</Text>}
            {HIDDEN_KINDS.flatMap(({ kind, title, symbol }) =>
              hidden
                .filter((h) => h.kind === kind)
                .map((h) => (
                  <HStack key={`${kind}:${h.key}`}>
                    <Label title={h.key} systemImage={symbol} />
                    <Spacer />
                    <Text modifiers={[font({ textStyle: "caption" }), secondary]}>{title}</Text>
                    <Button label="Unhide" onPress={() => onUnhide(h)} modifiers={[buttonStyle("borderless")]} />
                  </HStack>
                )),
            )}
          </Section>
          <Section title="Server">
            <Text modifiers={[secondary]}>{API_URL ?? "Not configured"}</Text>
          </Section>
          <Section>
            <Button
              label="Sign Out"
              role="destructive"
              onPress={() => {
                onDone();
                void signOut();
              }}
            />
          </Section>
        </Form>
        <Toolbar.Content>
          <ToolbarItem placement="confirmationAction">
            <Button label="Done" onPress={onDone} />
          </ToolbarItem>
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  );
}
