import { Action, ActionPanel, Icon, List, closeMainWindow } from "@raycast/api";
import { getProgressIcon, usePromise } from "@raycast/utils";
import { Doc, call, ensureRunning, openDoc, show } from "./steady";

export default function Command() {
  const { data, isLoading, error, revalidate } = usePromise(async () => {
    await ensureRunning();
    return call<Doc[]>("/api/library");
  });

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search your Steady library">
      {error ? <List.EmptyView icon={Icon.Warning} title="Couldn't reach Steady" description={error.message} /> : null}
      {data?.map((d) => (
        <List.Item
          key={d.id}
          icon={getProgressIcon(d.progress)}
          title={d.title}
          subtitle={d.kind}
          keywords={[d.kind]}
          accessories={[
            { text: `${Math.round(d.progress * 100)}%`, tooltip: `${d.words.toLocaleString()} words` },
            { date: new Date(d.opened * 1000), tooltip: "Last opened" },
          ]}
          actions={
            <ActionPanel>
              <Action title="Read in Steady" icon={Icon.Book} onAction={() => openDoc(d.id).then(() => closeMainWindow())} />
              <Action.CopyToClipboard title="Copy Title" content={d.title} />
              <Action
                title="Open Steady Library"
                icon={Icon.AppWindowList}
                shortcut={{ modifiers: ["cmd"], key: "l" }}
                onAction={() => show("").then(() => closeMainWindow())}
              />
              <Action title="Reload" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
