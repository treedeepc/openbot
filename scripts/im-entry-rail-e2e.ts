import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { chromium, type Page } from "playwright-core";
import { argument, connectChannelE2e, waitFor, writeReport } from "./channel-e2e-support";

const OUT = resolve(import.meta.dirname, "../.openbot-build/im-entry-rail-e2e");
const UI_WAIT_MS = 30_000;
const LOCALES = ["en", "zh"] as const;

const T = {
  railIm: LOCALES.map((locale) => translateFor(locale)("app.rail.im")),
  railMore: LOCALES.map((locale) => translateFor(locale)("app.rail.more")),
  inbox: LOCALES.map((locale) => translateFor(locale)("im.inbox.title")),
  contacts: LOCALES.map((locale) => translateFor(locale)("im.contacts.title")),
  session: LOCALES.map((locale) => translateFor(locale)("im.session.title")),
  devices: LOCALES.map((locale) => translateFor(locale)("im.devices.title")),
};

function namePattern(values: readonly string[]): RegExp {
  const parts = [...new Set(values)].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^(?:${parts.join("|")})$`);
}

const PANES = [
  { key: "im.inbox.title", values: T.inbox },
  { key: "im.contacts.title", values: T.contacts },
  { key: "im.session.title", values: T.session },
  { key: "im.devices.title", values: T.devices },
];

interface Report {
  target: string;
  labels: Record<string, string[]>;
  pageErrors: string[];
  screenshots: string[];
  railImButton: { found: boolean; where: "rail" | "more-menu" | "absent"; count: number };
  clicked: boolean;
  imPage: { open: boolean; panes: string[]; missingPanes: string[] };
  passed: boolean;
}

const report: Report = {
  target: "unknown",
  labels: {
    railIm: [...new Set(T.railIm)],
    railMore: [...new Set(T.railMore)],
    panes: PANES.map((pane) => `${pane.key}=${[...new Set(pane.values)].join("|")}`),
  },
  pageErrors: [],
  screenshots: [],
  railImButton: { found: false, where: "absent", count: 0 },
  clicked: false,
  imPage: { open: false, panes: [], missingPanes: [] },
  passed: false,
};

mkdirSync(OUT, { recursive: true });

const port = argument("port");
const devSession = port === undefined ? await connectChannelE2e("im-entry-rail-e2e") : null;
const packagedBrowser = port === undefined ? null : await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = packagedBrowser
  ? packagedBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.url().startsWith("devtools://"))
  : [];
const desktop: Page = devSession ? devSession.page : (pages[0] ?? fail("no app page on the CDP port"));
const closeAll = async (): Promise<void> => {
  if (devSession) await devSession.close();
  if (packagedBrowser) await packagedBrowser.close();
};
report.target = port === undefined ? "dev-app" : `packaged-cdp-${port}`;

function fail(message: string): never {
  throw new Error(message);
}

desktop.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));

async function shot(label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await desktop.screenshot({ path });
  report.screenshots.push(path);
}

const imRailButton = () => desktop.getByRole("button", { name: namePattern(T.railIm), exact: true });
const moreRailButton = () => desktop.getByRole("button", { name: namePattern(T.railMore), exact: true });

await desktop.locator(".window-rail-button").first().waitFor({ state: "visible", timeout: 90_000 });
await desktop.waitForTimeout(2_000);
await shot("01-initial");

const directCount = await imRailButton().count();
report.railImButton.count = directCount;
if (directCount > 0) {
  report.railImButton.found = true;
  report.railImButton.where = "rail";
} else if ((await moreRailButton().count()) > 0) {
  await moreRailButton().first().click();
  await desktop.waitForTimeout(800);
  await shot("02-more-menu");
  const menuIm = desktop.getByRole("menuitem", { name: namePattern(T.railIm), exact: true });
  const menuCount = (await menuIm.count()) + (await desktop.getByText(namePattern(T.railIm)).count());
  if (menuCount > 0) {
    report.railImButton.found = true;
    report.railImButton.count = menuCount;
    report.railImButton.where = "more-menu";
  }
}

if (!report.railImButton.found) {
  await shot("03-im-absent");
} else {
  const target =
    report.railImButton.where === "rail"
      ? imRailButton().first()
      : desktop.getByRole("menuitem", { name: namePattern(T.railIm), exact: true }).first();
  await shot("03-im-visible");
  await target.click();
  report.clicked = true;
  const panesSeen = async (): Promise<string[]> => {
    const seen: string[] = [];
    for (const pane of PANES) if ((await desktop.getByText(namePattern(pane.values)).count()) > 0) seen.push(pane.key);
    return seen;
  };
  await waitFor(desktop, "IM page panes", panesSeen, (seen) => seen.length > 0, UI_WAIT_MS).catch(() => []);
  const seen = await panesSeen();
  report.imPage.panes = seen;
  report.imPage.missingPanes = PANES.map((pane) => pane.key).filter((key) => !seen.includes(key));
  report.imPage.open = seen.length > 0;
  await shot("04-im-page");
}

report.passed = report.railImButton.found && report.clicked && report.imPage.open && report.pageErrors.length === 0;

const path = writeReport("im-entry-rail-e2e", report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`report: ${path}\n`);
for (const shotPath of report.screenshots) process.stdout.write(`shot: ${shotPath}\n`);

await closeAll();
if (!report.passed) process.exitCode = 1;
