import { createHmac } from "node:crypto";
import { prisma } from "./prisma";

// Normalize + HMAC-hash an email so the suppression list can match people
// across re-imports WITHOUT storing their address. Using HMAC (keyed with a
// server-side pepper) instead of a bare SHA means the list isn't reversible
// via a rainbow table of common emails.
export function hashEmail(email: string): string {
  const pepper = process.env.SUPPRESSION_PEPPER;
  if (!pepper) throw new Error("SUPPRESSION_PEPPER is not set");
  const normalized = email.trim().toLowerCase();
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

// Which of these emails are suppressed for this tenant? Returns a Set of the
// (lowercased) input emails that should be skipped.
export async function suppressedEmails(
  tenantId: string,
  emails: string[]
): Promise<Set<string>> {
  const byHash = new Map<string, string>();
  for (const e of emails) {
    if (!e) continue;
    const lower = e.trim().toLowerCase();
    byHash.set(hashEmail(lower), lower);
  }
  if (byHash.size === 0) return new Set();

  const hits = await prisma.suppression.findMany({
    where: { tenantId, emailHash: { in: [...byHash.keys()] } },
    select: { emailHash: true },
  });

  const out = new Set<string>();
  for (const h of hits) {
    const email = byHash.get(h.emailHash);
    if (email) out.add(email);
  }
  return out;
}

// Add an email to the suppression list (idempotent).
export async function suppress(
  tenantId: string,
  email: string,
  reason: "opt_out" | "deleted"
): Promise<void> {
  const emailHash = hashEmail(email);
  await prisma.suppression.upsert({
    where: { tenantId_emailHash: { tenantId, emailHash } },
    create: { tenantId, emailHash, reason },
    update: { reason },
  });
}
