import { ItemList } from "../components/item-list";

export default function PullRequests() {
  return <ItemList type="pr" title="Pull Requests" emptyText="No Pull Requests" />;
}
