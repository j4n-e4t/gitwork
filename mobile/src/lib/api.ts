import * as SecureStore from "expo-secure-store";
import type { HiddenItem, ItemDetails, ItemType, WorkView } from "../../../server/types.ts";

export type { HiddenItem, ItemDetails, ItemType, WorkItem, WorkView } from "../../../server/types.ts";

/** The session is missing, expired or its GitHub token was revoked. */
export class UnauthorizedError extends Error {}

// The gitwork Worker, baked in at build time (see mobile/.env.local). The session id lives in the keychain and is sent
// as a bearer token.
export const API_URL = process.env.EXPO_PUBLIC_API_URL;
const SESSION_KEY = "session";

async function request(path: string, init: RequestInit = {}) {
  if (!API_URL) throw new Error("EXPO_PUBLIC_API_URL isn't set (see mobile/.env.local)");
  const headers = new Headers(init.headers);
  const session = await SecureStore.getItemAsync(SESSION_KEY);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 401) {
    if (session) await SecureStore.deleteItemAsync(SESSION_KEY);
    throw new UnauthorizedError("Signed out");
  }
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res;
}

// `visible` has the server leave out hidden and checked-off items, so the board follows its rules.
export async function fetchWork(fresh = false): Promise<WorkView> {
  return (await request(fresh ? "/api/work?visible=1&fresh=1" : "/api/work?visible=1")).json();
}

export async function fetchItem(item: { type: ItemType; owner: string; repo: string; number: number }): Promise<ItemDetails> {
  const params = new URLSearchParams({ type: item.type, owner: item.owner, repo: item.repo, number: String(item.number) });
  return (await request(`/api/item?${params}`)).json();
}

export type Me = { login: string; avatarUrl: string };

export async function fetchMe(): Promise<Me> {
  return (await request("/api/me")).json();
}

export async function setHidden(item: HiddenItem, hidden: boolean) {
  await request("/api/hidden", { method: hidden ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
}

// Ends the session on the server too. The keychain entry goes either way, so a failed request still signs out here.
export async function signOut() {
  await request("/auth/logout", { method: "POST" }).catch(() => {});
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export type DeviceLogin = { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number };

// GitHub device flow: show `userCode`, the user enters it at `verificationUri`, then poll.
export async function startDeviceLogin(): Promise<DeviceLogin> {
  return (await request("/auth/device", { method: "POST" })).json();
}

/** Resolves true once signed in, or false (with GitHub's requested poll interval, if any) while still waiting. */
export async function pollDeviceLogin(deviceCode: string): Promise<{ done: boolean; interval: number | null }> {
  const res = await request("/auth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  const body = await res.json();
  if (res.status === 202) return { done: false, interval: body.interval };
  await SecureStore.setItemAsync(SESSION_KEY, body.session);
  return { done: true, interval: null };
}
