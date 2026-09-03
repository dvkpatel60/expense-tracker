/**
 * The screenshot audit the redesign plan kept referring to and the repo never had.
 *
 * Start the dev server first (npm run dev:vite), then: npm run audit
 *
 * It drives the real app through the sample data and reports the things a test
 * suite cannot see: horizontal overflow per view, whether the pinned lens is
 * clipped rather than scrolling, how many treemap cells are big enough to
 * label, whether the chart's crosshair actually fires, and any console error.
 *
 * On a /mnt/c (WSL) checkout Vite's file watcher misses edits, so it can serve
 * a stale module and the audit will describe code you no longer have. If a
 * change is missing from a shot, restart with `npx vite --force` after
 * `rm -rf node_modules/.vite`.
 *
 * Coordinates are viewport-relative: scrollIntoViewIfNeeded before any raw
 * page.mouse.move, or the pointer lands somewhere else entirely.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

// Override with AUDIT_OUT to keep shots out of the working tree.
const OUT = process.env.AUDIT_OUT ?? "audit-shots";
const BASE = process.env.AUDIT_URL ?? "http://127.0.0.1:5173/";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const shot = async (name, opts = {}) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log("shot:", name);
};

// Does the page scroll sideways? That is the clipping check the plan asks for.
const overflow = async (label) => {
  const r = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    docH: document.documentElement.scrollHeight,
  }));
  console.log(`overflow[${label}] scrollW=${r.docW} innerW=${r.winW} scrollH=${r.docH}` +
    (r.docW > r.winW + 1 ? "  <-- HORIZONTAL OVERFLOW" : ""));
  return r;
};

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /sample data/i }).click();
await page.getByText(/where it went/i).waitFor();
await page.waitForTimeout(600);

await shot("01-overview-ring", { fullPage: true });
await overflow("overview");

// Ring drill: click the first group in the key, let the arcs animate, capture.
const key = page.locator(".donut-key-row").first();
const group = await key.locator(".donut-key-label").innerText();
await key.click();
await page.waitForTimeout(500);
await shot("02-ring-drilled", { clip: { x: 0, y: 0, width: 1440, height: 980 } });
console.log("drilled into:", group);
await page.getByRole("button", { name: /all groups/i }).click();
await page.waitForTimeout(400);

// Treemap.
await page.getByRole("button", { name: /^Treemap$/ }).click();
await page.waitForTimeout(300);
await page.locator(".breakdown").screenshot({ path: `${OUT}/03-treemap.png` });
const cells = await page.locator(".tm-cell").count();
const labels = await page.locator(".tm-label").count();
const tmBox = await page.locator(".treemap").boundingBox();
console.log(`treemap: ${cells} cells, ${labels} labelled, box ${Math.round(tmBox.width)}x${Math.round(tmBox.height)}`);
await page.getByRole("button", { name: /^Ring$/ }).click();

// Pinned lens.
await page.locator(".cat-row").first().click();
await page.locator(".lens.pinned").waitFor();
await page.waitForTimeout(250);
await shot("04-lens-pinned");
const clip = await page.evaluate(() => {
  const el = document.querySelector(".lens.pinned");
  return { scrollH: el.scrollHeight, clientH: el.clientHeight };
});
console.log("lens content:", JSON.stringify(clip),
  clip.scrollH > clip.clientH ? "(scrolls - ok)" : "(fits - ok)");
const lensBox = await page.locator(".lens.pinned").boundingBox();
console.log("lens box:", JSON.stringify(lensBox), "viewport 1440x980",
  lensBox && (lensBox.y + lensBox.height > 980 || lensBox.x + lensBox.width > 1440)
    ? "<-- LENS OFF SCREEN" : "(on screen)");
await page.keyboard.press("Escape");

// Chart crosshair tooltip.
const chart = page.locator(".chart").first();
await chart.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const cb = await chart.boundingBox();
await page.mouse.move(cb.x + cb.width * 0.55, cb.y + cb.height * 0.5);
await page.waitForTimeout(250);
await chart.screenshot({ path: `${OUT}/05-chart-tooltip.png` });
console.log("chart tip present:", await page.locator(".chart-tip").count() > 0,
  "| chart width:", Math.round(cb.width));

// Copilot rail, setup open.
await page.mouse.move(10, 10);
await page.getByRole("button", { name: /^Setup$/ }).click();
await page.waitForTimeout(250);
await page.locator(".copilot").screenshot({ path: `${OUT}/06-copilot.png` });

// Other views.
for (const [name, file] of [["Activity", "07-activity"], ["People", "08-people"], ["Import", "09-import"]]) {
  await page.getByRole("button", { name: new RegExp("^" + name) }).click();
  await page.waitForTimeout(500);
  await shot(file, { fullPage: true });
  await overflow(name);
}

// Accounts, which task-03 un-orphaned.
const accountsTab = page.getByRole("button", { name: /^Accounts/ });
if (await accountsTab.count()) {
  await accountsTab.click();
  await page.waitForTimeout(400);
  await shot("10-accounts", { fullPage: true });
}

// Import: the rejection list, driven with a deliberately broken row.
await page.getByRole("button", { name: /^Import/ }).click();
await page.getByPlaceholder(/paste the contents/i).fill(
  "Date,Description,Amount\n2026-08-01,COFFEE,-4.50\n2026-08-02,MYSTERY,\n"
);
await page.waitForTimeout(300);
await page.locator("summary", { hasText: /why/i }).first().click();
await page.waitForTimeout(200);
await page.locator(".detected").screenshot({ path: `${OUT}/11-import-rejects.png` });
console.log("detected text:", (await page.locator(".detected").innerText()).replace(/\n/g, " | "));

// Narrow viewport: the lens bottom-sheet fallback under 720px.
await page.setViewportSize({ width: 600, height: 900 });
await page.getByRole("button", { name: /^Overview/ }).click();
await page.waitForTimeout(500);
await overflow("overview@600");
await page.locator(".cat-row").first().click();
await page.waitForTimeout(300);
await shot("12-mobile-lens");

console.log("\n=== console errors (" + errors.length + ") ===");
for (const e of errors.slice(0, 12)) console.log(" -", e.slice(0, 200));

await browser.close();
