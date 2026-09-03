import type { Person, PersonId } from "./types.js";

export function titleCase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, c: string) => "Mc" + c.toUpperCase())
    .trim();
}

/**
 * The same human arrives as SARAH MCKENNA on RBC, S MCKENNA on Wealthsimple,
 * and sometimes an email handle. Anchor on surname plus first initial, which
 * survives the initial-only form. This is a heuristic and it will occasionally
 * be wrong, so PersonId is stable but Person.aliases keeps every spelling seen
 * and the UI can offer a merge or a split.
 */
export function personIdFor(rawName: string): PersonId {
  const cleaned = rawName
    .replace(/@.*$/, " ")
    .replace(/[^A-Za-z'\-\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "person:unknown";
  if (parts.length === 1) return `person:${parts[0]!.toLowerCase()}`;
  const surname = parts[parts.length - 1]!.toLowerCase().replace(/[.'-]/g, "");
  const initial = parts[0]![0]!.toLowerCase();
  return `person:${surname}|${initial}`;
}

/** Merge a newly seen spelling into the roster, preferring the fullest name. */
export function observePerson(
  people: readonly Person[],
  rawName: string
): { people: Person[]; person: Person } {
  const id = personIdFor(rawName);
  const display = titleCase(rawName);
  const existing = people.find((p) => p.id === id);
  if (!existing) {
    const person: Person = { id, displayName: display, aliases: [display] };
    return { people: [...people, person], person };
  }
  const aliases = existing.aliases.includes(display)
    ? existing.aliases
    : [...existing.aliases, display];
  const displayName =
    display.length > existing.displayName.length ? display : existing.displayName;
  const person: Person = { ...existing, displayName, aliases };
  return { people: people.map((p) => (p.id === id ? person : p)), person };
}
