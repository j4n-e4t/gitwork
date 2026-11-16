import type { BundledLanguage, Highlighter, ThemedToken } from "shiki";

export type Token = Pick<ThemedToken, "content" | "color" | "fontStyle">;

const THEME = "github-dark-default";
// File names without a telling extension.
const BY_NAME: Record<string, string> = { dockerfile: "docker", makefile: "make", "cmakelists.txt": "cmake" };

// Shiki and each grammar are loaded on first use, so the board doesn't pay for them until a diff is opened. The
// JavaScript regex engine avoids shipping Oniguruma's WASM.
let highlighter: Promise<Highlighter> | null = null;
function getHighlighter() {
  highlighter ??= Promise.all([import("shiki"), import("shiki/engine/javascript")]).then(([shiki, { createJavaScriptRegexEngine }]) =>
    shiki.createHighlighter({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() }),
  );
  return highlighter;
}

async function languageFor(path: string) {
  const { bundledLanguages } = await import("shiki");
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const lang = BY_NAME[name] ?? (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : null);
  return lang && lang in bundledLanguages ? (lang as BundledLanguage) : null;
}

/** Tokens for each line of `code`, or null for languages Shiki doesn't know. */
export async function highlightLines(path: string, code: string): Promise<Token[][] | null> {
  const lang = await languageFor(path);
  if (!lang) return null;
  const shiki = await getHighlighter();
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(lang);
  return shiki.codeToTokens(code, { lang, theme: THEME }).tokens;
}
