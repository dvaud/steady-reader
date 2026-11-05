import { BrowserExtension, environment, getDefaultApplication, getFrontmostApplication } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { run, sendUrl } from "./steady";

// Browsers that tell AppleScript the address of their current tab.
const SAFARI = ["Safari", "Safari Technology Preview", "Orion"];
const CHROMIUM = ["Google Chrome", "Google Chrome Canary", "Arc", "Brave Browser", "Microsoft Edge", "Vivaldi", "Chromium", "Opera", "Dia"];

async function currentUrl(): Promise<string | undefined> {
  // The browser you were just in, otherwise your default browser.
  let app = await getFrontmostApplication();
  if (![...SAFARI, ...CHROMIUM].includes(app.name)) {
    app = await getDefaultApplication("https://example.com").catch(() => app);
  }
  const quoted = JSON.stringify(app.name);
  try {
    if (SAFARI.includes(app.name)) return await runAppleScript(`tell application ${quoted} to return URL of front document`);
    if (CHROMIUM.includes(app.name)) return await runAppleScript(`tell application ${quoted} to return URL of active tab of front window`);
  } catch {
    // No window open, or Raycast isn't allowed to ask the browser yet.
  }
  // Firefox and others: Raycast's browser extension, if it's installed.
  if (environment.canAccess(BrowserExtension)) {
    const tabs = await BrowserExtension.getTabs().catch(() => []);
    return tabs.find((t) => t.active)?.url;
  }
}

export default async function Command() {
  await run(async () => {
    const url = (await currentUrl())?.trim();
    if (!url || !/^https?:/.test(url)) throw new Error("Open a web page in your browser first.");
    return sendUrl(url);
  });
}
