import Anthropic from "@anthropic-ai/sdk";

// The three AI jobs, as typed contracts. Implementations are stubbed until we
// have a real KW Command CSV to design prompts against — the shapes here are
// what the rest of the app depends on, so they can be built in parallel.

const MODEL = "claude-sonnet-5";

export function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export interface ParsedProfile {
  priceMin: number | null;
  priceMax: number | null;
  bedsMin: number | null;
  bathsMin: number | null;
  location: string[];
  mustHaves: string[];
  niceToHaves: string[];
  lifestyleTags: string[];
  dealbreakers: string[];
  confidence: number; // 0..1
}

export interface ExtractedListing {
  address: string | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  features: string[];
}

export interface RankedMatch {
  contactId: string;
  score: number; // 0..100
  reasons: string[];
}

// 1) Parse a contact's free-text notes into structured buyer criteria.
export async function parseProfile(
  _notes: string,
  _rawFields: Record<string, unknown>
): Promise<ParsedProfile> {
  // TODO: implement against real KW columns. Prompt Claude to return the
  // ParsedProfile JSON, being conservative about price ("mid-6s" -> 550k-650k)
  // and flagging low confidence when notes are thin.
  throw new Error("parseProfile: not implemented (waiting on sample CSV)");
}

// 2) Extract structured features from a pasted MLS listing.
export async function extractListing(
  _rawText: string
): Promise<ExtractedListing> {
  // TODO: implement. Claude parses the pasted listing text/fields.
  throw new Error("extractListing: not implemented");
}

// 3) Rank pre-filtered buyers against a listing, with a reason per buyer.
export async function rankMatches(
  _listing: ExtractedListing,
  _candidates: Array<{ contactId: string; profile: ParsedProfile }>
): Promise<RankedMatch[]> {
  // TODO: implement. Hard-filter (price/beds) happens BEFORE this in the API
  // route; this call does the semantic scoring + "why".
  throw new Error("rankMatches: not implemented");
}

// 4) Draft a personalized email for one buyer about one listing, in the
// agent's voice, citing that buyer's own reasons.
export async function draftEmail(_input: {
  agentVoiceSample?: string;
  buyerName: string;
  reasons: string[];
  listing: ExtractedListing;
  unsubscribeUrl: string;
}): Promise<{ subject: string; body: string }> {
  // TODO: implement. Must reference the buyer's specific reasons (not a
  // mail-merge) and include the unsubscribe link.
  throw new Error("draftEmail: not implemented");
}

export { MODEL };
