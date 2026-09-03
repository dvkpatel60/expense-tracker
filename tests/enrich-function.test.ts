import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/enrich.mjs";

const post = (body: unknown): Request =>
  new Request("https://example.test/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const anthropicReply = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });

const geminiReply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
  });

describe("enrich function", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    vi.unstubAllGlobals();
  });

  it("reports 503 when no key is configured rather than failing opaquely", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const res = await handler(post({ merchants: ["LOBLAWS"] }));
    expect(res.status).toBe(503);
  });

  it("names the env vars an operator has to set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const body = await (await handler(post({ merchants: ["LOBLAWS"] }))).json();
    expect(body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(body.error).toMatch(/GEMINI_API_KEY/);
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

  it("normalizes the provider envelope into facts", async () => {
    vi.stubGlobal("fetch", async () =>
      anthropicReply('[{"key":"LOBLAWS","name":"Loblaws","category":"Groceries"}]')
    );
    const res = await handler(post({ merchants: ["LOBLAWS"] }));
    const body = await res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0]).toMatchObject({ key: "LOBLAWS", categoryId: "Groceries" });
    // The raw envelope never reaches the browser.
    expect(body.content).toBeUndefined();
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

describe("provider dispatch", () => {
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    vi.unstubAllGlobals();
  });

  it("routes to Gemini and keeps the key in a header", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return geminiReply('[{"key":"LOBLAWS","name":"Loblaws"}]');
    });

    const res = await handler(post({ merchants: ["LOBLAWS"], provider: "gemini" }));
    expect(res.status).toBe(200);
    const [url, init] = calls[0]!;
    expect(url).toContain("gemini-2.5-flash:generateContent");
    expect(url).not.toContain("gem-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gem-key");
    expect(await res.text()).not.toContain("gem-key");
  });

  it("honours the requested model", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return geminiReply("[]");
    });
    await handler(post({ merchants: ["A"], provider: "gemini", model: "gemini-2.0-flash-lite" }));
    expect(calls[0]).toContain("gemini-2.0-flash-lite:generateContent");
  });

  it("refuses a model outside the catalogue instead of relaying it", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const res = await handler(
      post({ merchants: ["A"], provider: "gemini", model: "gemini-3-ultra" })
    );
    expect(res.status).toBe(400);
  });

  it("refuses an unknown provider", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const res = await handler(post({ merchants: ["A"], provider: "openai" }));
    expect(res.status).toBe(400);
  });

  it("reports 503 for a known provider whose key is missing", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const res = await handler(post({ merchants: ["A"], provider: "gemini" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/GEMINI_API_KEY/);
  });

  it("falls back to whichever provider is configured when none is named", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return geminiReply("[]");
    });
    const res = await handler(post({ merchants: ["A"] }));
    expect(res.status).toBe(200);
    expect(calls[0]).toContain("generativelanguage.googleapis.com");
  });

  it("does not leak an unreadable upstream response as success", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    vi.stubGlobal("fetch", async () => geminiReply("not json at all"));
    const res = await handler(post({ merchants: ["A"], provider: "gemini" }));
    expect(res.status).toBe(502);
  });
});
