import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/insights.mjs";
import type { InsightsDigest } from "../src/core/digest.js";
import { cents } from "../src/core/money.js";

const digest: InsightsDigest = {
  period: "2026-08",
  totals: {
    cashOut: cents(-100000),
    yourShare: cents(-80000),
    recovered: cents(-20000),
    transactionCount: 12,
  },
  previousTotals: null,
  categories: [
    {
      categoryId: "Dining",
      yourShare: cents(40000),
      cashOut: cents(60000),
      transactionCount: 6,
      previousYourShare: cents(20000),
    },
  ],
  topMerchants: [{ merchant: "LA CARNITA COLLEGE", yourShare: cents(10730), transactionCount: 1 }],
  openClaims: { count: 2, total: cents(15000) },
  recurringCandidates: [],
  savingsOpportunity: [],
  topMerchantDelta: [],
};

const post = (body: unknown): Request =>
  new Request("https://example.test/api/insights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ANSWER = JSON.stringify([
  { kind: "headline", text: "Dining is most of your month." },
  { kind: "trend", text: "Up $200 on July.", categoryId: "Dining" },
]);

const anthropicReply = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });

const geminiReply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
  });

describe("insights function", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    vi.unstubAllGlobals();
  });

  it("names the env vars an operator has to set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const res = await handler(post({ digest }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(body.error).toMatch(/GEMINI_API_KEY/);
  });

  it("requires POST", async () => {
    const res = await handler(new Request("https://example.test/api/insights"));
    expect(res.status).toBe(405);
  });

  // The privacy boundary is enforced server side, not merely promised by the client.
  it("rejects a digest carrying anything but aggregates", async () => {
    expect((await handler(post({}))).status).toBe(400);
    expect((await handler(post({ digest: { period: "2026-08-14" } }))).status).toBe(400);
    const smuggled = {
      ...digest,
      topMerchants: [
        { merchant: "etransfer:person:mckenna|s", yourShare: cents(1), transactionCount: 1 },
      ],
    };
    const res = await handler(post({ digest: smuggled }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/counterparty/i);
  });

  it("sends the aggregates and nothing else upstream", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return anthropicReply(ANSWER);
    });

    const res = await handler(post({ digest }));
    expect(res.status).toBe(200);

    const sent = String(calls[0]!.body);
    expect(sent).toContain("LA CARNITA COLLEGE");
    // No day-level dates and no counterparty keys reach the provider.
    expect(sent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(sent).not.toContain("etransfer:");
  });

  it("normalizes the provider envelope away before replying", async () => {
    vi.stubGlobal("fetch", async () => anthropicReply(ANSWER));
    const body = await (await handler(post({ digest }))).json();
    expect(body.insights[0].kind).toBe("headline");
    expect(body.insights[1].categoryId).toBe("Dining");
    expect(body.content).toBeUndefined();
    expect(body.candidates).toBeUndefined();
  });

  it("routes to Gemini and honours a model from the catalogue", async () => {
    process.env["GEMINI_API_KEY"] = "gem-key";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return geminiReply(ANSWER);
    });

    const body = await (
      await handler(post({ digest, provider: "gemini", model: "gemini-2.0-flash" }))
    ).json();
    expect(body.provider).toBe("gemini");
    expect(body.model).toBe("gemini-2.0-flash");
    expect(urls[0]).toContain("gemini-2.0-flash:generateContent");
    // The key travels in a header, never in the URL.
    expect(urls[0]).not.toContain("gem-key");
  });

  // Without this the function is an open relay to any model on the account.
  it("refuses a model that is not in the catalogue", async () => {
    const res = await handler(post({ digest, model: "claude-please-bankrupt-me" }));
    expect(res.status).toBe(400);
  });

  it("refuses an unknown provider", async () => {
    expect((await handler(post({ digest, provider: "hal9000" }))).status).toBe(400);
  });

  it("reports 503 for a provider this deployment has no key for", async () => {
    const res = await handler(post({ digest, provider: "gemini" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/GEMINI_API_KEY/);
  });

  it("returns only the status when the provider errors, never its body", async () => {
    vi.stubGlobal("fetch", async () => new Response("x-api-key: test-key leaked", { status: 401 }));
    const body = await (await handler(post({ digest }))).json();
    expect(body.error).not.toContain("test-key");
    expect(body.error).toMatch(/401/);
  });

  it("reports an unparseable answer as a bad gateway, not a success", async () => {
    vi.stubGlobal("fetch", async () => anthropicReply("I'd rather write a poem."));
    expect((await handler(post({ digest }))).status).toBe(502);
  });
});
