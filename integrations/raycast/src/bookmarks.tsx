import { Action, ActionPanel, Icon, List, closeMainWindow } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Doc, call, ensureRunning, openDoc } from "./steady";

export default function Command() {
  const { data, isLoading, error } = usePromise(async () => {
    await ensureRunning();
    return (await call<Doc[]>("/api/library")).filter((d) => d.bookmarks.length);
  });

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search your Steady bookmarks">
      {error ? <List.EmptyView icon={Icon.Warning} title="Couldn't reach Steady" description={error.message} /> : null}
      {data && !data.length ? (
        <List.EmptyView icon={Icon.Bookmark} title="No bookmarks yet" description="In Steady, press B or select text and choose Bookmark." />
      ) : null}
      {data?.map((d) => (
        <List.Section key={d.id} title={d.title}>
          {d.bookmarks.map((m) => (
            <List.Item
              key={m.at}
              icon={Icon.Bookmark}
              title={m.t || "…"}
              keywords={[d.title]}
              accessories={[{ date: new Date(m.at), tooltip: "Bookmarked" }]}
              actions={
                <ActionPanel>
                  <Action title="Read from Here" icon={Icon.Book} onAction={() => openDoc(d.id, `${m.b}.${m.w}`).then(() => closeMainWindow())} />
                  <Action.CopyToClipboard title="Copy Text" content={m.t} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
