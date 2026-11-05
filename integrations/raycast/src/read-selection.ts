import { getSelectedText } from "@raycast/api";
import { run, sendText } from "./steady";

export default async function Command() {
  await run(async (toast) => {
    let text = "";
    try {
      text = await getSelectedText();
    } catch {
      // No selection, or the app doesn't share it.
    }
    if (!text.trim()) throw new Error("Select some text first.");
    return sendText(text, toast);
  });
}
