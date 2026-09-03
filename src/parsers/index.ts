import { rbcParser } from "./rbc.js";
import { scotiabankParser } from "./scotiabank.js";
import { wealthsimpleParser } from "./wealthsimple.js";
import { genericParser } from "./generic.js";
import type { FiId, ParseResult, Parser } from "../core/types.js";

/** Registry. Adding an FI is one file, one entry, one fixture test. */
export const PARSERS: readonly Parser[] = [
  rbcParser,
  scotiabankParser,
  wealthsimpleParser,
  genericParser,
];

export interface Detection {
  readonly parser: Parser;
  readonly confidence: number;
  readonly runnerUp: { id: FiId; confidence: number } | null;
}

export function detectParser(text: string): Detection {
  const scored = PARSERS.map((parser) => ({ parser, confidence: parser.detect(text) })).sort(
    (a, b) => b.confidence - a.confidence
  );
  const best = scored[0]!;
  const second = scored[1];
  return {
    parser: best.parser,
    confidence: best.confidence,
    runnerUp: second ? { id: second.parser.id, confidence: second.confidence } : null,
  };
}

export function parseStatement(text: string, forceFi?: FiId): ParseResult & { confidence: number } {
  if (forceFi) {
    const parser = PARSERS.find((p) => p.id === forceFi);
    if (!parser) throw new Error(`No parser registered for ${forceFi}`);
    return { ...parser.parse(text), confidence: 1 };
  }
  const { parser, confidence } = detectParser(text);
  return { ...parser.parse(text), confidence };
}

export { rbcParser, scotiabankParser, wealthsimpleParser, genericParser };
