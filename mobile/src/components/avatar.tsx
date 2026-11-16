import { RNHostView } from "@expo/ui/swift-ui";
import { Image } from "react-native";

// A round GitHub avatar inside SwiftUI. SwiftUI's Image only loads local files, so this hosts a React Native Image,
// which fetches and caches the URL.
export function Avatar({ uri, size }: { uri: string | null | undefined; size: number }) {
  return (
    <RNHostView matchContents>
      <Image
        source={uri ? { uri } : undefined}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "rgba(127,127,127,0.2)" }}
      />
    </RNHostView>
  );
}
