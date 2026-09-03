import { describe, expect, it, vi } from "vitest";
import { enrichMerchants, redactForLookup } from "../src/enrich/enricher.js";
import { buildEnrichmentPrompt } from "../src/enrich/prompt.js";
import { anthropicTransport, parseResponse } from "../src/enrich/anthropic.js";
import type { MerchantFacts } from "../src/core/types.js";

const fact = (key: string): MerchantFacts => ({ key, name: key, retrievedOn: "2026-09-01" });

describe("enrichMerchants", () => {
  it("only looks up merchants that are not cached", async () => {
    const lookup = vi.fn(async (keys: readonly string[]) => keys.map(fact));
    const r = await enrichMerchants({ lookup }, ["A", "B", "A"], { A: fact("A") });
    expect(lookup).toHaveBeenCalledWith(["B"]);
    expect(r.servedFromCache).toBe(1);
    expect(r.requested).toBe(1);
  });

  it("never sends a person's name to the network", () => {
    expect(redactForLookup(["LOBLAWS", "etransfer:person:mckenna|s"])).toEqual(["LOBLAWS"]);
  });

  it("skips the network entirely when everything is cached", async () => {
    const lookup = vi.fn();
    const r = await enrichMerchants({ lookup }, ["A"], { A: fact("A") });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.failed).toBe(false);
  });

  it("keeps the batches that worked when one fails", async () => {
    let call = 0;
    const lookup = async (keys: readonly string[]) => {
      if (++call === 2) throw new Error("rate limited");
      return keys.map(fact);
    };
    const r = await enrichMerchants({ lookup }, ["A", "B", "C", "D"], {}, { batchSize: 2 });
    expect(r.failed).toBe(true);
    expect(r.facts).toHaveLength(2);
    expect(r.error).toMatch(/rate limited/);
  });
});

describe("response parsing", () => {
  const wrap = (text: string) => ({ content: [{ type: "text", text }] });

  it("reads a clean array", () => {
    const out = parseResponse(
      wrap('[{"key":"BLUE DOOR COFFEE","name":"Blue Door Coffee","category":"Coffee","commonlyShared":false}]'),
      "2026-09-01"
    );
    expect(out[0]).toMatchObject({ name: "Blue Door Coffee", categoryId: "Coffee" });
  });

  it("tolerates code fences", () => {
    expect(parseResponse(wrap('```json\n[{"key":"A","name":"A"}]\n```'), "2026-09-01")).toHaveLength(1);
  });

  it("drops a category that is not in the taxonomy", () => {
    const out = parseResponse(wrap('[{"key":"A","name":"A","category":"Nonsense"}]'), "2026-09-01");
    expect(out[0]?.categoryId).toBeUndefined();
  });

  it("skips malformed entries instead of failing the batch", () => {
    const out = parseResponse(wrap('[{"name":"no key"},{"key":"B","name":"B"},null]'), "2026-09-01");
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("B");
  });

  it("throws on a response that is not an array", () => {
    expect(() => parseResponse(wrap('{"key":"A"}'), "2026-09-01")).toThrow();
  });

  it("drops a provider that names itself as the merchant", () => {
    const out = parseResponse(
      wrap(
        '[{"key":"ANTHROPIC","name":"Anthropic","category":"Subscription"},{"key":"LOBLAWS","name":"Loblaws","category":"Groceries"},{"key":"gemini","name":"Gemini","category":"Subscription"}]'
      ),
      "2026-09-01"
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Loblaws");
  });
});

describe("enrichment prompt", () => {
  it("explicitly forbids provider names as merchants", () => {
    const prompt = buildEnrichmentPrompt(["LOBLAWS"]);
    expect(prompt).toContain("Anthropic");
    expect(prompt).toContain("Gemini");
    expect(prompt).toContain("not merchants");
  });

  it("lists every key it is asked to identify", () => {
    const prompt = buildEnrichmentPrompt(["LOBLAWS", "BLUE DOOR COFFEE"]);
    expect(prompt).toContain("- LOBLAWS");
    expect(prompt).toContain("- BLUE DOOR COFFEE");
  });
});

describe("transport", () => {
  it("sends merchant strings and nothing else", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: '[{"key":"LOBLAWS","name":"Loblaws"}]' }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const t = anthropicTransport({ today: "2026-09-01", fetchImpl });
    await t.lookup(["LOBLAWS"]);
    const body = String(calls[0]?.body);
    expect(body).toContain("LOBLAWS");
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(body).not.toMatch(/balance|account/i);
  });

  it("throws on a non-2xx status", async () => {
    const fetchImpl = async () => new Response("nope", { status: 429 });
    const t = anthropicTransport({ today: "2026-09-01", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(t.lookup(["A"])).rejects.toThrow(/429/);
  });
});
