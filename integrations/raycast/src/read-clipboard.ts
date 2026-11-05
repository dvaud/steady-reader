import { Clipboard } from "@raycast/api";
import { run, sendFile, sendText } from "./steady";
import { fileURLToPath } from "node:url";

export default async function Command() {
  await run(async (toast) => {
    const { text, file } = await Clipboard.read();
    if (file) return sendFile(file.startsWith("file:") ? fileURLToPath(file) : file, toast); // a file copied in Finder
    if (!text?.trim()) throw new Error("The clipboard has no text.");
    return sendText(text, toast);
  });
}
