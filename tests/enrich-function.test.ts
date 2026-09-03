import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/enrich.mjs";

const post = (body: unknown): Request =>
  new Request("https://example.test/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("enrich function", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    vi.unstubAllGlobals();
  });

  it("reports 503 when no key is configured rather than failing opaquely", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const res = await handler(post({ merchants: ["LOBLAWS"] }));
    expect(res.status).toBe(503);
  });

  it("rejects anything that is not a merchant list", async () => {
    expect((await handler(post({}))).status).toBe(400);
    expect((await handler(post({ merchants: [] }))).status).toBe(400);
    expect((await handler(post({ merchants: [123] }))).status).toBe(400);
  });

  it("caps the batch size", async () => {
    const res = await handler(post({ merchants: new Array(500).fill("SHOP") }));
    expect(res.status).toBe(413);
  });

  // The privacy boundary is enforced server side, not just promised by the client.
  it("refuses counterparty keys", async () => {
    const res = await handler(post({ merchants: ["etransfer:person:mckenna|s"] }));
    expect(res.status).toBe(400);
  });

  it("forwards merchants and keeps the key out of the response", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "[]" }] }), {
        status: 200,
      });
    });
    const res = await handler(post({ merchants: ["LOBLAWS", "BLUE DOOR COFFEE"] }));
    expect(res.status).toBe(200);

    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(String(init.body)).toContain("BLUE DOOR COFFEE");
    expect(await res.text()).not.toContain("test-key");
  });

  it("does not leak upstream failures as success", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 429 }));
    const res = await handler(post({ merchants: ["LOBLAWS"] }));
    expect(res.status).toBe(502);
  });

  it("only accepts POST", async () => {
    const res = await handler(new Request("https://example.test/api/enrich"));
    expect(res.status).toBe(405);
  });
});
