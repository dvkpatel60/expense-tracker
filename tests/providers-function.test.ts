import { afterEach, describe, expect, it } from "vitest";
import handler from "../netlify/functions/providers.mjs";
import { reconcile } from "../src/ui/settings.js";
import type { ProviderAvailability } from "../src/enrich/providers.js";

const get = (): Request => new Request("https://example.test/api/providers");

describe("providers function", () => {
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
  });

  it("reports nothing as configured on a bare deployment", async () => {
    const body = await (await handler(get())).json();
    expect(body.providers.every((p: ProviderAvailability) => !p.configured)).toBe(true);
  });

  it("marks only the providers whose key is set", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const body = await (await handler(get())).json();
    const byId = Object.fromEntries(
      body.providers.map((p: ProviderAvailability) => [p.id, p.configured])
    );
    expect(byId["gemini"]).toBe(true);
    expect(byId["anthropic"]).toBe(false);
  });

  // The whole point of the endpoint is to say what is available without saying
  // what the credentials are.
  it("never returns key material", async () => {
    process.env["GEMINI_API_KEY"] = "AIzaSyTOTALLY-SECRET-VALUE";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-secret";
    const text = await (await handler(get())).text();
    expect(text).not.toContain("AIzaSy");
    expect(text).not.toContain("sk-ant");
  });

  it("only accepts GET", async () => {
    const res = await handler(new Request("https://example.test/api/providers", { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

/* ------------------------------------------------------------------ */

const avail = (
  id: "anthropic" | "gemini",
  configured: boolean,
  models: string[],
  def: string
): ProviderAvailability => ({
  id,
  label: id,
  envVar: `${id.toUpperCase()}_API_KEY`,
  models: models.map((m) => ({ id: m, label: m })),
  defaultModel: def,
  configured,
});

describe("settings reconciliation", () => {
  const catalogue = [
    avail("anthropic", false, ["claude-sonnet-5"], "claude-sonnet-5"),
    avail("gemini", true, ["gemini-2.5-flash", "gemini-2.0-flash"], "gemini-2.5-flash"),
  ];

  it("returns null when the deployment can do nothing", () => {
    expect(reconcile(null, [avail("gemini", false, ["x"], "x")])).toBeNull();
  });

  it("picks the first configured provider with no stored choice", () => {
    expect(reconcile(null, catalogue)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  });

  it("keeps a stored choice that is still available", () => {
    expect(reconcile({ provider: "gemini", model: "gemini-2.0-flash" }, catalogue)).toEqual({
      provider: "gemini",
      model: "gemini-2.0-flash",
    });
  });

  // A key removed from the deployment must not strand the app on a dead choice.
  it("falls back when the stored provider lost its key", () => {
    expect(reconcile({ provider: "anthropic", model: "claude-sonnet-5" }, catalogue)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  });

  it("falls back to the default when the stored model left the catalogue", () => {
    expect(reconcile({ provider: "gemini", model: "gemini-1.0-pro" }, catalogue)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  });
});
