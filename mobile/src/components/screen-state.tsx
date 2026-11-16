import { Button, ContentUnavailableView, ProgressView } from "@expo/ui/swift-ui";
import { buttonStyle, navigationTitle } from "@expo/ui/swift-ui/modifiers";
import { useDeviceLogin } from "../lib/device-login";
import { isSignedOut, useWork } from "../lib/work";

// Loading, sign-in and error placeholders shown in place of a tab's list.
export function ScreenState({ title }: { title: string }) {
  const { view, error, refresh } = useWork();
  const device = useDeviceLogin(refresh);
  const modifiers = [navigationTitle(title)];

  if (isSignedOut(error)) {
    if (device.login) {
      return (
        <ContentUnavailableView
          title={device.login.userCode}
          systemImage="key.fill"
          description="Enter this code on GitHub to sign in. This screen updates once you approve it."
          actions={<Button label="Copy Code and Open GitHub" onPress={device.openGitHub} modifiers={[buttonStyle("glassProminent")]} />}
          modifiers={modifiers}
        />
      );
    }
    return (
      <ContentUnavailableView
        title="Sign in to gitwork"
        systemImage="person.crop.circle"
        description={device.error ?? "Sign in with GitHub to see your pull requests, issues, discussions and to-dos."}
        actions={
          <Button
            label={device.starting ? "Starting…" : "Sign in with GitHub"}
            onPress={device.start}
            modifiers={[buttonStyle("glassProminent")]}
          />
        }
        modifiers={modifiers}
      />
    );
  }
  if (error && !view) {
    return (
      <ContentUnavailableView
        title="Couldn’t Load Your Work"
        systemImage="wifi.exclamationmark"
        description={error.message}
        actions={<Button label="Try Again" onPress={refresh} modifiers={[buttonStyle("glass")]} />}
        modifiers={modifiers}
      />
    );
  }
  return <ProgressView modifiers={modifiers} />;
}
