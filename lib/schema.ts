import { HttpError } from "./http";

// Clue tables for a case live in schema case_<slug> (slug validated by a DB CHECK and here).
export function schemaFor(slug: string): string {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) throw new HttpError(500, "Invalid case configuration");
  return `case_${slug}`;
}
