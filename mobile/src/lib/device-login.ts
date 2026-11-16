import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Linking } from "react-native";
import { pollDeviceLogin, startDeviceLogin, type DeviceLogin } from "./api";

// Sign-in through GitHub's device flow: show a code, open github.com/login/device, poll until it's approved.
export function useDeviceLogin(onSignedIn: () => void) {
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!login) return;
    let timer: ReturnType<typeof setTimeout>;
    const poll = (seconds: number) => {
      timer = setTimeout(() => {
        pollDeviceLogin(login.deviceCode).then(
          ({ done, interval }) => (done ? onSignedIn() : poll(interval ?? seconds)),
          (err: Error) => {
            setError(err.message);
            setLogin(null);
          },
        );
      }, seconds * 1000);
    };
    poll(login.interval);
    return () => clearTimeout(timer);
  }, [login, onSignedIn]);

  const start = () => {
    setStarting(true);
    setError(null);
    startDeviceLogin()
      .then(setLogin, (err: Error) => setError(err.message))
      .finally(() => setStarting(false));
  };

  // Safari rather than an in-app browser, so an existing GitHub sign-in is reused.
  const openGitHub = async () => {
    if (!login) return;
    await Clipboard.setStringAsync(login.userCode);
    await Linking.openURL(login.verificationUri);
  };

  return { login, starting, error, start, openGitHub };
}
