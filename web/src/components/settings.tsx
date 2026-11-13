import { ArrowDown, ArrowUp, Eye, EyeOff } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { authorKey, reasonApplies, type HiddenItem, type Reason } from "@/lib/api";
import { COLUMNS, MODES } from "@/lib/board";

const HIDDEN_KINDS: { kind: HiddenItem["kind"]; title: string }[] = [
  { kind: "owner", title: "Owners" },
  { kind: "repo", title: "Repositories" },
  { kind: "pr", title: "Items" },
  { kind: "author", title: "Authors" },
];

type SettingsProps = {
  summaryEnabled: boolean;
  // False when the server has no Gemini key, which leaves the switch off and disabled.
  summaryAvailable: boolean;
  onSummaryEnabledChange: (enabled: boolean) => void;
  todosEnabled: boolean;
  onTodosEnabledChange: (enabled: boolean) => void;
  showHidden: boolean;
  onShowHiddenChange: (show: boolean) => void;
  showCheckedOff: boolean;
  onShowCheckedOffChange: (show: boolean) => void;
  columnOrder: Reason[];
  onMoveColumn: (reason: Reason, target: Reason) => void;
  precedence: Reason[];
  onMovePrecedence: (reason: Reason, target: Reason) => void;
  // null while the board is still loading.
  hidden: HiddenItem[] | null;
  onHide: (item: HiddenItem) => void;
  onUnhide: (item: HiddenItem) => void;
};

export function Settings(props: SettingsProps) {
  const { hidden } = props;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
      <Section title="What is shown">
        <SwitchRow
          id="show-checked-off"
          label="Show checked-off items"
          description="Closed and merged items stay on the board until you check them off; this shows them again, dimmed."
          checked={props.showCheckedOff}
          onCheckedChange={props.onShowCheckedOffChange}
        />
        <SwitchRow
          id="show-hidden"
          label="Show hidden items"
          description="Hidden owners, repositories and items appear dimmed on the board."
          checked={props.showHidden}
          onCheckedChange={props.onShowHiddenChange}
        />
      </Section>

      <Section title="Features" description="Optional features, off by default.">
        <SwitchRow
          id="feature-summary"
          label="AI summaries"
          description={
            props.summaryAvailable
              ? "A Summary tab in the item preview that writes a short overview with Gemini. The item's text and metadata are sent to Google."
              : "Unavailable: the server has no Gemini API key (GOOGLE_GENERATIVE_AI_API_KEY)."
          }
          disabled={!props.summaryAvailable}
          checked={props.summaryEnabled}
          onCheckedChange={props.onSummaryEnabledChange}
        />
        <SwitchRow
          id="feature-todos"
          label="Todos"
          description="Tasks with optional deadlines, linked to items if you like: a Todos view, counts on cards and a Todos tab in the preview."
          checked={props.todosEnabled}
          onCheckedChange={props.onTodosEnabledChange}
        />
      </Section>

      <Section title="Column order" description="Columns that don't apply to a view are skipped there.">
        <ReasonList order={props.columnOrder} onMove={props.onMoveColumn} />
      </Section>

      <Section
        title="Precedence"
        description="An item that matches several columns only shows in the highest one here, e.g. a PR you authored and were mentioned in only shows under Authored."
      >
        <ReasonList order={props.precedence} onMove={props.onMovePrecedence} />
      </Section>

      <Section
        title="Hidden"
        description="Hide owners, repositories and items from a card's menu on the board, or hide everything by an author here."
      >
        <HideAuthorForm onHide={props.onHide} />
        {hidden?.length === 0 && <p className="text-sm text-muted-foreground">Nothing hidden.</p>}
        {HIDDEN_KINDS.map(({ kind, title }) => {
          const items = (hidden ?? []).filter((h) => h.kind === kind);
          if (!items.length) return null;
          return (
            <div key={kind} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
              <ul className="divide-y rounded-lg border">
                {items.map((item) => (
                  <li key={item.key} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3">
                    <span className="min-w-0 flex-1 truncate text-sm">{item.key}</span>
                    <Button variant="ghost" size="sm" onClick={() => props.onUnhide(item)}>
                      <Eye /> Unhide
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

// GitHub logins are letters, digits and hyphens; bots may be typed with their "[bot]" suffix.
const LOGIN = /^[a-z\d-]+$/;

function HideAuthorForm({ onHide }: { onHide: (item: HiddenItem) => void }) {
  const [login, setLogin] = useState("");
  const key = authorKey(login.replace(/^@/, ""));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!LOGIN.test(key)) return;
    onHide({ kind: "author", key });
    setLogin("");
  };
  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        placeholder="Hide everything by an author, e.g. dependabot"
        aria-label="Author to hide"
        aria-invalid={login.trim() !== "" && !LOGIN.test(key)}
      />
      <Button type="submit" variant="secondary" disabled={!LOGIN.test(key)}>
        <EyeOff /> Hide author
      </Button>
    </form>
  );
}

// Reorderable list of the board's columns, with the views each one appears in.
function ReasonList({ order, onMove }: { order: Reason[]; onMove: (reason: Reason, target: Reason) => void }) {
  return (
    <ol className="divide-y rounded-lg border">
      {order.map((reason, index) => {
        const { title, icon: Icon } = COLUMNS[reason];
        const modes = MODES.filter((m) => reasonApplies(reason, m.value)).map((m) => m.label);
        return (
          <li key={reason} className="flex items-center gap-3 px-3 py-2">
            <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
            <Icon className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{title}</p>
              <p className="truncate text-xs text-muted-foreground">{modes.join(", ")}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={index === 0}
              onClick={() => onMove(reason, order[index - 1]!)}
              aria-label={`Move ${title} up`}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={index === order.length - 1}
              onClick={() => onMove(reason, order[index + 1]!)}
              aria-label={`Move ${title} down`}
            >
              <ArrowDown />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SwitchRow(props: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={props.id}>{props.label}</Label>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Switch id={props.id} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onCheckedChange} />
    </div>
  );
}
