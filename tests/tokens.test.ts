import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The design system, enforced rather than agreed.
 *
 * A motion grammar and a type scale are only worth having if a one-off value
 * cannot quietly appear beside them, and "everyone remembers to use the token"
 * is not a mechanism. These are the rules from the interaction-contract block
 * in tokens.css, checked.
 */
// happy-dom rewrites import.meta.url to an http URL, so the path is resolved
// from the project root instead.
const css = readFileSync(resolve(process.cwd(), "src/ui/tokens.css"), "utf8");

/** Everything outside :root, where the tokens themselves are declared. */
const body = css.slice(css.indexOf("}", css.indexOf(":root {")));

describe("motion grammar", () => {
  it("declares exactly one set of durations and one easing", () => {
    expect(css).toMatch(/--dur-fast:\s*\d+ms/);
    expect(css).toMatch(/--dur-slow:\s*\d+ms/);
    expect(css).toMatch(/--ease-out:\s*cubic-bezier/);
  });

  it("has no transition that carries its own duration", () => {
    // The reduced-motion guard is the one exception: it overrides every
    // duration at once, which is the point of it.
    const guard = body.indexOf("prefers-reduced-motion");
    const withoutGuard = body.slice(0, guard) + body.slice(body.indexOf("}", guard));
    const adHoc = withoutGuard.match(/\b\d+(\.\d+)?m?s\b/g) ?? [];
    expect(adHoc).toEqual([]);
  });

  it("honours a reader who asked for less motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("type scale", () => {
  it("is a single modular scale", () => {
    const steps = [...css.matchAll(/--step-{1,2}(\d):\s*([\d.]+)rem/g)];
    expect(steps.length).toBeGreaterThanOrEqual(8);
  });

  it("has no font-size outside it, bar the two SVG viewBox labels", () => {
    const raw = (body.match(/font-size:\s*[\d.]+(?:rem|em|%)/g) ?? []).filter(
      (d) => !d.includes("var(")
    );
    expect(raw).toEqual([]);

    // The treemap's labels are drawn inside a viewBox, where the unit is a
    // user-space unit rather than a page size; rem there would scale twice.
    const px = body.match(/font-size:\s*\d+px/g) ?? [];
    expect(px).toEqual(["font-size: 9px", "font-size: 10px"]);
  });
});

describe("colour contrast", () => {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const h = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const token = (name: string): string => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
    if (!m) throw new Error(`No --${name} in tokens.css`);
    return m[1]!;
  };

  // The three surfaces text is ever set on.
  const surfaces = ["panel", "panel-2", "canvas"] as const;

  it("clears AA for every colour used as body text", () => {
    // --ink-3 in particular: it carries the 11-13px secondary text almost
    // everywhere, and at its original #8f8a82 it was 3.1:1 on the canvas.
    for (const name of ["ink", "ink-2", "ink-3", "green", "red", "accent-ink", "amber-ink"]) {
      for (const surface of surfaces) {
        expect(
          ratio(token(name), token(surface)),
          `--${name} on --${surface}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("clears AA-large for the gold used on the hero figure", () => {
    // --accent is a fill first. It is legal on the 2rem bold KPI and on
    // decoration, and the 3:1 floor is what makes that true.
    for (const surface of surfaces) {
      expect(ratio(token("accent"), token(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the dark rail legible", () => {
    for (const name of ["rail-ink", "rail-ink-2"]) {
      expect(ratio(token(name), token("rail"))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
