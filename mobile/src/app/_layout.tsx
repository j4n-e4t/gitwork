import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useColorScheme } from "react-native";
import { WorkProvider } from "../lib/work";

// The system tab bar (Liquid Glass on iOS 26), which shrinks to the selected tab's button while scrolling down.
// Each tab draws its own SwiftUI navigation stack and list.
export default function RootLayout() {
  // The theme keeps tab switches from flashing white in dark mode.
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <WorkProvider>
        <NativeTabs minimizeBehavior="onScrollDown">
          <NativeTabs.Trigger name="index">
            <NativeTabs.Trigger.Label>PRs</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon sf="arrow.triangle.pull" />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="issues">
            <NativeTabs.Trigger.Label>Issues</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon sf="smallcircle.filled.circle" />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="discussions">
            <NativeTabs.Trigger.Label>Discussions</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} />
          </NativeTabs.Trigger>
        </NativeTabs>
      </WorkProvider>
    </ThemeProvider>
  );
}
