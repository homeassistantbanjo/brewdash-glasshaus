import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import { auth, CURRENT_TENANT_ID } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { suppressedEmails } from "@/lib/suppression";
import { normalizeRow } from "@/lib/import";

// CSV import with a suppression-aware, hand-edit-preserving upsert.
// Returns a summary the UI shows as a diff before/after committing.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tenantId = CURRENT_TENANT_ID;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    return NextResponse.json(
      { error: "csv parse error", detail: parsed.errors.slice(0, 3) },
      { status: 400 }
    );
  }

  const rows = parsed.data.map(normalizeRow).filter((r) => r.name || r.email);

  // 1) Skip anyone on the suppression list — they must never be resurrected.
  const emails = rows.map((r) => r.email).filter(Boolean) as string[];
  const suppressed = await suppressedEmails(tenantId, emails);

  const summary = {
    total: rows.length,
    created: 0,
    updated: 0,
    skippedSuppressed: 0,
    notesChanged: 0,
    noEmail: 0,
  };

  for (const r of rows) {
    if (r.email && suppressed.has(r.email)) {
      summary.skippedSuppressed++;
      continue;
    }
    if (!r.email) {
      // Without an email we can't dedupe safely; count and skip for now.
      // TODO: allow crmId-only keying once we know the export has an id.
      summary.noEmail++;
      continue;
    }

    const existing = await prisma.contact.findUnique({
      where: { tenantId_email: { tenantId, email: r.email } },
    });

    if (!existing) {
      await prisma.contact.create({
        data: {
          tenantId,
          crmId: r.crmId,
          name: r.name,
          email: r.email,
          phone: r.phone,
          sourceNotes: r.notes,
          rawFields: r.rawFields,
          status: "active",
        },
      });
      summary.created++;
      continue;
    }

    const notesChanged =
      (existing.sourceNotes ?? "").trim() !== (r.notes ?? "").trim();
    if (notesChanged) summary.notesChanged++;

    await prisma.contact.update({
      where: { id: existing.id },
      data: {
        // Never silently flip a contact out of a lifecycle state the agent set.
        // (status is intentionally NOT updated from the CSV.)
        crmId: r.crmId ?? existing.crmId,
        // Preserve hand edits: only refresh raw/notes when not hand-edited.
        ...(existing.handEdited
          ? {}
          : {
              name: r.name || existing.name,
              phone: r.phone ?? existing.phone,
              sourceNotes: r.notes,
              rawFields: r.rawFields,
            }),
      },
    });
    summary.updated++;
  }

  // TODO: after upsert, enqueue re-parse for the `notesChanged` contacts whose
  // profile.editedByUser is false.
  return NextResponse.json({ ok: true, summary });
}
