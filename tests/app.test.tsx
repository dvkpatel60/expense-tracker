import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(await screen.findByText(/you spent/i)).toBeTruthy();
    // Cash out with the paired card payment excluded.
    expect(screen.getByText(/left your accounts/i).textContent).toContain("$2,129.41");
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
    expect(payment.closest("button")?.textContent).toMatch(/between your accounts/i);
  });

  it("splits a bill and moves your share without moving cash out", async () => {
    const user = await boot();
    const cashOutBefore = screen.getByText(/left your accounts/i).textContent;

    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    // The list is virtualized, so reach the row through search rather than
    // assuming every transaction is mounted.
    await user.type(screen.getByPlaceholderText("Search"), "carnita");
    await user.click(await screen.findByText(/La Carnita/i));

    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Priya/ }));
    await user.click(within(sheet).getByRole("button", { name: /split evenly/i }));

    await user.click(screen.getByRole("button", { name: /^Summary/ }));
    const note = await screen.findByText(/is other people/i);
    expect(note.textContent).toContain("$107.30");
    // Cash out is unchanged; only the share moved.
    expect(note.textContent).toContain(String(cashOutBefore?.match(/\$[\d,.]+/)?.[0] ?? ""));
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
    await user.type(screen.getByPlaceholderText("Search"), "carnita");
    await user.click(await screen.findByText(/La Carnita/i));

    let sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Priya/ }));
    await user.click(within(sheet).getByRole("button", { name: /split evenly/i }));

    await user.clear(screen.getByPlaceholderText("Search"));
    await user.type(screen.getByPlaceholderText("Search"), "priya");
    await user.click(await screen.findByText(/Priya Ramaswamy/i));
    sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /settle/i }));

    await user.click(screen.getByRole("button", { name: /^People/ }));
    const priyaRow = (await screen.findByText("Priya Ramaswamy")).closest(".row");
    expect(priyaRow).toBeTruthy();
    expect(within(priyaRow as HTMLElement).getByText(/settled up/i)).toBeTruthy();
    // And the open-claim badge on the tab is gone.
    expect(screen.getByRole("button", { name: /^People/ }).querySelector(".badge")).toBeNull();
  });
});
