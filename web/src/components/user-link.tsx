import { useEffect, useState, type ReactElement } from "react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ProfileSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

// Enough to show a user: Person has all of it; a mention in a body only has the login.
type User = { login: string; avatarUrl?: string; url?: string | null };

// The one way a user is shown: avatar, name and a profile hover card. `pill` is for mentions inside text, so they
// read as references like issue links do. `avatar={false}` is for places that already show the avatar elsewhere.
// A null user is GitHub's deleted-account "ghost".
export function UserLink({
  user,
  pill = false,
  avatar = true,
  className,
}: {
  user: User | null;
  pill?: boolean;
  avatar?: boolean;
  className?: string;
}) {
  if (!user) return <span className={cn("font-medium text-foreground", className)}>ghost</span>;
  // Commit authors without a GitHub account have a git name but no profile.
  const url = user.url === undefined ? `https://github.com/${user.login}` : user.url;
  const content = (
    <>
      {avatar && <UserAvatar user={user} />}
      {user.login}
    </>
  );
  const linkClass = cn(
    "font-medium text-foreground",
    // Without the avatar it stays plain inline text, so a surrounding `truncate` can still cut it off.
    avatar && "inline-flex max-w-full items-center gap-1.5 align-bottom",
    pill ? "gap-1 rounded-md bg-muted px-1.5 align-middle hover:bg-accent" : "hover:underline",
    className,
  );
  if (!url) return <span className={linkClass}>{content}</span>;
  return (
    <ProfileHoverCard user={user}>
      <a href={url} target="_blank" rel="noreferrer" className={linkClass}>
        {content}
      </a>
    </ProfileHoverCard>
  );
}

// The profile hover card on its own, for layouts UserLink doesn't fit. `children` must be a single element that
// accepts a ref and pointer handlers.
export function ProfileHoverCard({ user, children }: { user: User; children: ReactElement }) {
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <ProfileCard user={user} />
      </HoverCardContent>
    </HoverCard>
  );
}

function UserAvatar({ user, className }: { user: User; className?: string }) {
  return (
    <Avatar className={cn("size-4", className)}>
      {/* An empty avatarUrl is a commit author without an account; the initial shows instead. */}
      {user.avatarUrl !== "" && <AvatarImage src={user.avatarUrl ?? `https://github.com/${user.login}.png?size=64`} alt="" />}
      <AvatarFallback className="text-[0.5rem]">{user.login[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

const STACK_SIZE = 5;

// Overlapping avatars of everyone involved, each with its profile card; the rest are listed in the "+N" card.
export function UserStack({ users, className }: { users: User[]; className?: string }) {
  const shown = users.slice(0, STACK_SIZE);
  const rest = users.slice(STACK_SIZE);
  return (
    <AvatarGroup aria-label="Involved" className={className}>
      {shown.map((user) => (
        <ProfileHoverCard key={user.login} user={user}>
          <a href={user.url ?? `https://github.com/${user.login}`} target="_blank" rel="noreferrer" aria-label={user.login} className="rounded-full">
            <UserAvatar user={user} className="size-6 ring-2 ring-popover" />
          </a>
        </ProfileHoverCard>
      ))}
      {rest.length > 0 && (
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <AvatarGroupCount tabIndex={0} className="size-6 text-xs ring-popover">
              +{rest.length}
            </AvatarGroupCount>
          </HoverCardTrigger>
          <HoverCardContent align="end" className="w-56">
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {rest.map((user) => (
                <li key={user.login} className="truncate">
                  <UserLink user={user} />
                </li>
              ))}
            </ul>
          </HoverCardContent>
        </HoverCard>
      )}
    </AvatarGroup>
  );
}

// Profiles are fetched on first hover and kept for the session; failures are dropped so the next hover retries.
const profiles = new Map<string, Promise<ProfileSummary | null>>();
function loadProfile(login: string) {
  let profile = profiles.get(login);
  if (!profile) {
    profile = api.profile(login).catch(() => {
      profiles.delete(login);
      return null;
    });
    profiles.set(login, profile);
  }
  return profile;
}

// Bots link to their app page. Their logins aren't profile names (some even belong to an unrelated organization),
// so they aren't looked up.
const isBot = (user: User) => user.url?.startsWith("https://github.com/apps/") ?? false;

function ProfileCard({ user }: { user: User }) {
  const { login } = user;
  const bot = isBot(user);
  const [profile, setProfile] = useState<ProfileSummary | null | undefined>();
  useEffect(() => {
    if (bot) return;
    let current = true;
    loadProfile(login).then((p) => current && setProfile(p));
    return () => {
      current = false;
    };
  }, [login, bot]);
  // Bots, and accounts GitHub has no profile for, get what we already know.
  if (bot || profile === null) {
    return (
      <div className="flex items-center gap-3">
        <UserAvatar user={user} className="size-10" />
        <div className="min-w-0">
          <p className="truncate font-medium">{login}</p>
          <p className="text-xs text-muted-foreground">{bot ? "Bot" : "No public profile"}</p>
        </div>
      </div>
    );
  }
  if (profile === undefined) {
    return (
      <div className="flex gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-full" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <Avatar className="size-10">
        <AvatarImage src={profile.avatarUrl} alt="" />
        <AvatarFallback>{profile.login[0]?.toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 space-y-1">
        <p className="truncate">
          {profile.name && <span className="font-medium">{profile.name} </span>}
          <span className={cn(!profile.name && "font-medium", profile.name && "text-muted-foreground")}>{profile.login}</span>
        </p>
        {profile.bio && <p className="line-clamp-3">{profile.bio}</p>}
        <p className="text-xs text-muted-foreground">
          {profile.location && <>{profile.location} · </>}
          Joined {new Date(profile.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
      </div>
    </div>
  );
}
