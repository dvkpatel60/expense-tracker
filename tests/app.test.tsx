import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui/App.js";
import { describeProviders } from "../src/enrich/providers.js";

/** Stand in for a deployment where only the named providers have a key set. */
function deploymentOffering(...configured: string[]): void {
  const providers = describeProviders((spec) => configured.includes(spec.id));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/providers")) {
      return new Response(JSON.stringify({ providers }), { status: 200 });
    }
    throw new Error(`Unstubbed fetch: ${url}`);
  });
}

/** The figure shown on one KPI card, by its label. */
function kpi(label: string): string {
  const card = screen.getByText(label).closest(".kpi");
  return card?.querySelector(".kpi-value")?.textContent ?? "";
}

const search = (): HTMLElement => screen.getByPlaceholderText(/^search/i);

/**
 * End-to-end through the real UI: load the fixtures, split a bill, settle it.
 * This is the test that would have caught the first prototype shipping a UI
 * that compiled but never rendered.
 */
async function boot() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /sample data/i }));
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("starts empty with a way in", async () => {
    render(<App />);
    expect(await screen.findByText(/nothing here yet/i)).toBeTruthy();
  });

  it("imports the fixtures and shows both totals", async () => {
    await boot();
    expect(await screen.findByText(/your spend/i)).toBeTruthy();
    // Cash out with the paired card payment excluded.
    expect(kpi("Cash out")).toContain("$2,129.41");
  });

  it("surfaces unrecognized merchants and unmatched transfers", async () => {
    await boot();
    expect(await screen.findByText(/merchants unrecognized/i)).toBeTruthy();
    expect(screen.getByText(/transfers unmatched/i)).toBeTruthy();
  });

  it("hides paired internal transfers from the spend total", async () => {
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    const payment = await screen.findByText(/Payment - Thank You/i);
    expect(payment.closest("button")?.textContent).toMatch(/internal/i);
  });

  it("splits a bill and moves your share without moving cash out", async () => {
    const user = await boot();
    const cashOutBefore = kpi("Cash out");

    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    // The list is virtualized, so reach the row through search rather than
    // assuming every transaction is mounted.
    await user.type(search(), "carnita");
    await user.click(await screen.findByText(/La Carnita/i));

    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Priya/ }));
    await user.click(within(sheet).getByRole("button", { name: /apply split/i }));

    await user.click(screen.getByRole("button", { name: /^Overview/ }));
    await screen.findByText(/your spend/i);
    expect(kpi("Recovered")).toContain("$107.30");
    // Cash out is unchanged; only the share moved.
    expect(kpi("Cash out")).toBe(cashOutBefore);
  });

  it("splits by percent through the strategy tabs", async () => {
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    await user.type(search(), "carnita");
    await user.click(await screen.findByText(/La Carnita/i));

    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Priya/ }));
    // Switch to the percent strategy and give Priya 30%.
    await user.click(within(sheet).getByRole("tab", { name: "Percent" }));
    const percentInput = within(sheet).getByPlaceholderText("%");
    await user.type(percentInput, "30");
    // Your share must be the remainder: 100 - 30 = 70%.
    expect(await within(sheet).findByText(/your share 70%/)).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: /apply split/i }));

    await user.click(screen.getByRole("button", { name: /^Overview/ }));
    await screen.findByText(/your spend/i);
    // 70% of $214.60 is $150.22 → recovered is the other 30% ≈ $64.38.
    expect(kpi("Recovered")).toContain("$64.38");
  });

  it("offers only the providers the deployment has keys for", async () => {
    deploymentOffering("gemini");
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    const provider = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    const offered = Array.from(provider.options).map((o) => o.textContent);
    expect(offered).toContain("Google Gemini");
    expect(offered).not.toContain("Anthropic");

    // And the model list follows the chosen provider.
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(Array.from(model.options).map((o) => o.value)).toContain("gemini-2.5-flash");
    expect(Array.from(model.options).map((o) => o.value)).not.toContain("claude-sonnet-5");
  });

  it("remembers the chosen model across a reload", async () => {
    deploymentOffering("gemini");
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    await user.selectOptions(await screen.findByLabelText("Model"), "gemini-2.0-flash-lite");

    // Remount rather than re-boot: the ledger is persisted by now, so a fresh
    // App is no longer on the welcome screen.
    cleanup();
    const again = userEvent.setup();
    render(<App />);
    await again.click(await screen.findByRole("button", { name: /^Import/ }));
    const model = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    expect(model.value).toBe("gemini-2.0-flash-lite");
  });

  it("says so plainly when no provider is configured", async () => {
    deploymentOffering();
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    expect(await screen.findByText(/not configured/i)).toBeTruthy();
    expect(screen.getByText(/GEMINI_API_KEY/)).toBeTruthy();
    expect(screen.queryByLabelText("Provider")).toBeNull();
  });

  it("settles a claim from an incoming e-transfer", async () => {
    const user = await boot();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    await user.type(search(), "carnita");
    await user.click(await screen.findByText(/La Carnita/i));

    let sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Priya/ }));
    await user.click(within(sheet).getByRole("button", { name: /apply split/i }));

    await user.clear(search());
    await user.type(search(), "priya");
    await user.click(await screen.findByText(/Priya Ramaswamy/i));
    sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /settle/i }));

    await user.click(screen.getByRole("button", { name: /^People/ }));
    const priyaCard = (await screen.findByText("Priya Ramaswamy")).closest(".person");
    expect(priyaCard).toBeTruthy();
    expect(within(priyaCard as HTMLElement).getByText(/settled up/i)).toBeTruthy();
    // And the open-claim badge on the tab is gone.
    expect(screen.getByRole("button", { name: /^People/ }).querySelector(".badge")).toBeNull();
  });

  /** The ring's key labels, which are the groups until a drill replaces them
   *  with that group's categories. Read from the DOM rather than by role,
   *  because the SVG is aria-hidden and the key is the text equivalent. */
  const ringLabels = (): string[] =>
    Array.from(document.querySelectorAll(".donut-key-label"), (e) => e.textContent ?? "");

  it("drills the ring from a group into its categories and back", async () => {
    const user = await boot();
    await screen.findByText(/where it went/i);

    const groups = ringLabels();
    expect(groups.length).toBeGreaterThan(1);

    const first = document.querySelector(".donut-key-row") as HTMLButtonElement;
    await user.click(first);

    // The key now lists what is inside that group, and the group itself is not
    // one of its own children.
    expect(ringLabels()).not.toContain(groups[0]);
    expect(ringLabels().length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /all groups/i }));
    expect(ringLabels()).toEqual(groups);
  });

  it("shows every category at once in the treemap", async () => {
    const user = await boot();
    await screen.findByText(/where it went/i);
    const groups = ringLabels().length;

    await user.click(screen.getByRole("button", { name: /^treemap$/i }));

    // One cell per category, which is strictly more than the six groups the
    // ring can show, and the ring's own key steps aside for it.
    expect(document.querySelectorAll(".tm-cell").length).toBeGreaterThan(groups);
    expect(document.querySelectorAll(".donut-key-row").length).toBe(0);
  });

  it("pins the category lens and opens a transaction from it", async () => {
    const user = await boot();
    await screen.findByText(/where it went/i);

    await user.click(document.querySelector(".cat-row") as HTMLButtonElement);

    const lens = document.querySelector(".lens.pinned") as HTMLElement;
    expect(lens).toBeTruthy();
    // Both figures, not just a list of transactions.
    expect(within(lens).getByText(/your share/i)).toBeTruthy();
    expect(within(lens).getByText(/cash out/i)).toBeTruthy();

    await user.click(lens.querySelector(".lens-row") as HTMLButtonElement);

    // The drawer took over; the lens got out of the way rather than stacking.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(document.querySelector(".lens")).toBeNull();
  });

  it("reads out both cumulative figures for the day under the cursor", async () => {
    await boot();
    await screen.findByText(/cumulative spend/i);

    const chart = document.querySelector(".chart") as HTMLElement;
    fireEvent.mouseMove(chart, { clientX: 240, clientY: 60 });

    const tip = document.querySelector(".chart-tip");
    expect(tip).toBeTruthy();
    expect(tip?.textContent).toMatch(/Cash out/);
    expect(tip?.textContent).toMatch(/Your share/);
  });
});
