import {
  AtSign,
  CircleDot,
  Eye,
  GitPullRequest,
  GitPullRequestArrow,
  MessageSquareReply,
  MessagesSquare,
  Star,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import type { ItemType, Reason } from "@/lib/api";

export const COLUMNS: Record<Reason, { title: string; icon: LucideIcon }> = {
  authored: { title: "Authored", icon: GitPullRequestArrow },
  review: { title: "Review requested", icon: Eye },
  assigned: { title: "Assigned", icon: UserCheck },
  mentioned: { title: "Mentioned", icon: AtSign },
  commented: { title: "Commented", icon: MessageSquareReply },
  watching: { title: "Watching", icon: Star },
};

// The board shows one item type at a time.
export type Mode = ItemType;

export const MODES: { value: ItemType; label: string; icon: LucideIcon }[] = [
  { value: "pr", label: "Pull requests", icon: GitPullRequest },
  { value: "issue", label: "Issues", icon: CircleDot },
  { value: "discussion", label: "Discussions", icon: MessagesSquare },
];
