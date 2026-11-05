import { getSelectedFinderItems } from "@raycast/api";
import { Doc, run, sendFile } from "./steady";

export default async function Command() {
  await run(async (toast) => {
    let paths: string[] = [];
    try {
      paths = (await getSelectedFinderItems()).map((f) => f.path);
    } catch {
      // Finder isn't the frontmost app.
    }
    if (!paths.length) throw new Error("Select a file in Finder first.");
    const docs: Doc[] = [];
    for (const [i, path] of paths.entries()) {
      if (paths.length > 1) toast.title = `Sending ${i + 1} of ${paths.length} to Steady…`;
      docs.push(await sendFile(path, toast));
    }
    return docs;
  });
}
