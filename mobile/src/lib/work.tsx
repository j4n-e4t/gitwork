import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe, fetchWork, setHidden, signOut as endSession, UnauthorizedError, type HiddenItem, type Me, type WorkView } from "./api";

type WorkState = {
  view: WorkView | null;
  me: Me | null;
  error: Error | null;
  loading: boolean;
  // Resolves once the board has reloaded, for pull-to-refresh.
  refresh: () => Promise<void>;
  unhide: (item: HiddenItem) => Promise<void>;
  signOut: () => Promise<void>;
};

const WorkContext = createContext<WorkState | null>(null);

const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

// One board fetch shared by all four tabs.
export function WorkProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<WorkView | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((fresh: boolean) => {
    fetchMe().then(setMe, () => {});
    return fetchWork(fresh)
      .then((next) => {
        setView(next);
        setError(null);
        // The server answered from an old cache: show it, then fetch a fresh copy like the web app does.
        if (next.stale && !fresh) return fetchWork(true).then(setView);
      })
      .catch((err) => setError(toError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => {
    setLoading(true);
    return load(true);
  }, [load]);

  // The server filters hidden items out, so the board is reloaded (from its cache) to bring the item back.
  const unhide = useCallback(
    async (item: HiddenItem) => {
      await setHidden(item, false);
      await load(false);
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await endSession();
    setView(null);
    setMe(null);
    setError(new UnauthorizedError("Signed out"));
  }, []);

  return (
    <WorkContext.Provider value={{ view, me, error, loading, refresh, unhide, signOut }}>{children}</WorkContext.Provider>
  );
}

export function useWork() {
  const state = useContext(WorkContext);
  if (!state) throw new Error("useWork must be used inside WorkProvider");
  return state;
}

// Annotated so TypeScript doesn't infer a type predicate: UnauthorizedError is structurally an Error, so the
// predicate would narrow the other branch to never.
export const isSignedOut = (error: Error | null): boolean => error instanceof UnauthorizedError;
