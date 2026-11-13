import { env } from "cloudflare:workers";
import { createGoogle } from "@ai-sdk/google";
import { generateText, jsonSchema, Output } from "ai";
import type { ItemSummary } from "./types.ts";

type SummaryFields = Pick<ItemSummary, "tldr" | "what" | "who" | "why" | "related" | "status">;

const field = (description: string) => ({ type: "string", description }) as const;
const SCHEMA = jsonSchema<SummaryFields>({
  type: "object",
  properties: {
    tldr: field("One sentence, at most 20 words, on the substance: what changes or what's wrong. Not its type or state."),
    what: field("The concrete change or request in at most two short sentences: what is done, where, and how."),
    who: field("People and their roles, e.g. \"@a (author), reviewed by @b; @c reported it\". Empty if only the author is involved."),
    why: field("The problem or motivation in one sentence, ending with the issues it fixes, e.g. \"Fixes #12.\". Empty if not stated."),
    related: field("Only references, comma-separated, each with a 2-4 word note in parentheses, e.g. \"#12 (original report), acme/api#7 (same bug)\". Empty if none."),
    status: field("One sentence on where it stands and what it's waiting on, naming specifics: who must review, which checks fail, open questions."),
  },
  required: ["tldr", "what", "who", "why", "related", "status"],
  additionalProperties: false,
});

const SYSTEM = `You write terse catch-up notes on GitHub pull requests, issues and discussions for an engineer who knows the codebase.
Rules:
- Telegraphic and specific. No filler, no hedging, no markdown, no restating the title.
- Never open with the item's type or state ("An open pull request…", "This PR…", "This issue…"); the UI already shows both. Start with the subject or a verb.
- Each field adds something new; never repeat information from another field.
- Use only the given context. Leave a field empty rather than guess or write "None", "N/A" or "not stated".
- Refer to people as @login. Refer to issues, PRs and discussions as #number in the same repository and owner/repo#number elsewhere, never by URL or title alone. Don't reference the item being summarized.
- For the status, the latest activity matters most.`;

// Long threads are cut in the middle of the text, keeping the top (metadata, description) and the latest activity.
const MAX_CONTEXT_CHARS = 400_000;

function trimContext(text: string) {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const half = MAX_CONTEXT_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_CONTEXT_CHARS} characters omitted …]\n\n${text.slice(-half)}`;
}

// The key is optional; without it the feature can't be turned on.
export const summaryAvailable = () => Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY);

export async function summarize(context: string, itemUpdatedAt: string): Promise<ItemSummary> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const { output } = await generateText({
    model: google(env.GEMINI_MODEL),
    system: SYSTEM,
    prompt: trimContext(context),
    output: Output.object({ schema: SCHEMA }),
  });
  if (!output) throw new Error("The model returned no summary");
  return { ...output, model: env.GEMINI_MODEL, generatedAt: new Date().toISOString(), itemUpdatedAt };
}
