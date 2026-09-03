import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_TOKENS,
  PROVIDERS,
  describeProviders,
  providerFor,
  resolveModel,
} from "../src/enrich/providers.js";
import { directTransport } from "../src/enrich/direct.js";
import { parseFacts } from "../src/enrich/facts.js";
import { MAX_MERCHANTS_PER_REQUEST } from "../src/enrich/prompt.js";

const KEYS = ["LOBLAWS", "BLUE DOOR COFFEE"];

describe("registry", () => {
  it("every provider declares a default that is in its own catalogue", () => {
    for (const p of PROVIDERS) {
      expect(p.models.some((m) => m.id === p.defaultModel)).toBe(true);
    }
  });

  it("ids and env vars are unique, so one provider cannot mask another", () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    expect(new Set(PROVIDERS.map((p) => p.envVar)).size).toBe(PROVIDERS.length);
  });

  it("resolves an unknown provider to null rather than guessing", () => {
    expect(providerFor("openai")).toBeNull();
    expect(providerFor(undefined)).toBeNull();
    expect(providerFor("gemini")?.label).toBe("Google Gemini");
  });
});

describe("resolveModel", () => {
  const gemini = providerFor("gemini")!;

  it("falls back to the default when nothing is asked for", () => {
    expect(resolveModel(gemini, undefined)).toBe("gemini-2.5-flash");
    expect(resolveModel(gemini, "")).toBe("gemini-2.5-flash");
  });

  it("accepts a model from the catalogue", () => {
    expect(resolveModel(gemini, "gemini-2.0-flash-lite")).toBe("gemini-2.0-flash-lite");
  });

  // Without this the function is an open relay to any model on the account.
  it("refuses a model that is not in the catalogue", () => {
    expect(resolveModel(gemini, "gemini-3-ultra-expensive")).toBeNull();
    expect(resolveModel(gemini, "claude-opus-5")).toBeNull();
    expect(resolveModel(gemini, { id: "x" })).toBeNull();
  });
});

describe("availability", () => {
  it("reports the env var name but never a value", () => {
    const out = describeProviders((spec) => spec.id === "gemini");
    const gemini = out.find((p) => p.id === "gemini")!;
    const anthropic = out.find((p) => p.id === "anthropic")!;
    expect(gemini.configured).toBe(true);
    expect(anthropic.configured).toBe(false);
    expect(gemini.envVar).toBe("GEMINI_API_KEY");
    expect(JSON.stringify(out)).not.toMatch(/AIza|sk-ant/);
  });
});

describe("output ceiling", () => {
  // A ceiling below the batch cap truncates the JSON mid-array, which fails the
  // whole batch rather than shortening it.
  it("is large enough for a full batch at ~36 tokens per merchant", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(MAX_MERCHANTS_PER_REQUEST * 36);
  });

  it("is applied by every provider", () => {
    for (const p of PROVIDERS) {
      const body = JSON.parse(p.buildRequest(p.defaultModel, KEYS, "k").body);
      const ceiling = body.max_tokens ?? body.generationConfig?.maxOutputTokens;
      expect(ceiling).toBe(MAX_OUTPUT_TOKENS);
    }
  });
});

describe("gemini wire format", () => {
  const gemini = providerFor("gemini")!;

  it("puts the key in a header and the model in the path", () => {
    const req = gemini.buildRequest("gemini-2.0-flash", KEYS, "secret-key");
    expect(req.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );
    // Not in the query string, where it would land in access logs.
    expect(req.url).not.toContain("secret-key");
    expect(req.headers["x-goog-api-key"]).toBe("secret-key");
  });

  it("omits the auth header entirely when there is no key", () => {
    const req = gemini.buildRequest("gemini-2.0-flash", KEYS, "");
    expect("x-goog-api-key" in req.headers).toBe(false);
  });

  it("sends merchant strings and nothing else", () => {
    const body = gemini.buildRequest("gemini-2.5-flash", KEYS, "k").body;
    expect(body).toContain("BLUE DOOR COFFEE");
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(body).not.toMatch(/balance|account number/i);
  });

  // 2.5 thinks by default and thinking is billed against the same ceiling, so a
  // long think returns MAX_TOKENS with empty text. 2.0 rejects the field.
  it("disables thinking on 2.5 and does not send the field to 2.0", () => {
    const on = JSON.parse(gemini.buildRequest("gemini-2.5-flash", KEYS, "k").body);
    expect(on.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
    const off = JSON.parse(gemini.buildRequest("gemini-2.0-flash", KEYS, "k").body);
    expect(off.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("reads text out of a candidate", () => {
    const text = gemini.extractText({
      candidates: [{ content: { parts: [{ text: '[{"key":"A",' }, { text: '"name":"A"}]' }] } }],
    });
    expect(parseFacts(text, "2026-09-01")[0]).toMatchObject({ key: "A", name: "A" });
  });

  it("explains an empty candidate instead of reporting a bad shape", () => {
    expect(() => gemini.extractText({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toThrow(
      /MAX_TOKENS/
    );
  });

  it("surfaces a safety block", () => {
    expect(() => gemini.extractText({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }))
      .toThrow(/SAFETY/);
  });
});

describe("directTransport", () => {
  it("drives whichever provider it is given", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '[{"key":"LOBLAWS","name":"Loblaws"}]' }] } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const t = directTransport({ provider: "gemini", today: "2026-09-01", fetchImpl });
    const facts = await t.lookup(["LOBLAWS"]);
    expect(facts[0]?.name).toBe("Loblaws");
    expect(seen[0]).toContain("gemini-2.5-flash:generateContent");
  });

  it("refuses a model the provider does not offer", async () => {
    const t = directTransport({ provider: "gemini", model: "gpt-4", today: "2026-09-01" });
    await expect(t.lookup(["A"])).rejects.toThrow(/cannot use the model/);
  });
});
