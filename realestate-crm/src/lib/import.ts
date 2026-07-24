// Map a raw CSV row (unknown KW Command columns) into our normalized shape.
// The header guesses below are deliberately broad; we lock them to the real
// export once we have a sample. See ../PLAN.md phase 0.

export interface NormalizedRow {
  crmId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  rawFields: Record<string, string>;
}

const pick = (row: Record<string, string>, candidates: string[]): string | null => {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === cand);
    if (hit && row[hit]?.trim()) return row[hit].trim();
  }
  // fuzzy contains
  for (const cand of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase().includes(cand));
    if (hit && row[hit]?.trim()) return row[hit].trim();
  }
  return null;
};

export function normalizeRow(row: Record<string, string>): NormalizedRow {
  const first = pick(row, ["first name", "firstname", "first"]);
  const last = pick(row, ["last name", "lastname", "last"]);
  const full = pick(row, ["name", "full name", "contact name"]);
  const name = (full || [first, last].filter(Boolean).join(" ")).trim();

  return {
    crmId: pick(row, ["crm id", "contact id", "id", "kw id"]),
    name,
    email: pick(row, ["email", "e-mail", "email address"])?.toLowerCase() ?? null,
    phone: pick(row, ["phone", "mobile", "cell", "phone number"]),
    // The gold: "what they're looking for". Try common note/criteria fields.
    notes: pick(row, [
      "notes",
      "note",
      "criteria",
      "looking for",
      "buyer criteria",
      "description",
      "comments",
    ]),
    rawFields: row,
  };
}

// Stable hash of notes so re-import only re-parses when the notes changed.
export function notesFingerprint(notes: string | null): string {
  return (notes ?? "").trim().toLowerCase();
}
