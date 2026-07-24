import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CURRENT_TENANT_ID } from "@/lib/auth";
import { suppress } from "@/lib/suppression";
import { statusChip } from "@/components/status";

export const dynamic = "force-dynamic";

// --- Lifecycle server actions ---

async function setStatus(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const status = String(formData.get("status")) as any;
  const contact = await prisma.contact.findFirst({
    where: { id, tenantId: CURRENT_TENANT_ID },
  });
  if (!contact) return;

  await prisma.contact.update({
    where: { id },
    data: { status, statusChangedAt: new Date() },
  });

  // Opting out also adds an enduring suppression so re-import can't undo it.
  if (status === "do_not_contact" && contact.email) {
    await suppress(CURRENT_TENANT_ID, contact.email, "opt_out");
  }
  revalidatePath(`/contacts/${id}`);
}

async function deleteContact(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const contact = await prisma.contact.findFirst({
    where: { id, tenantId: CURRENT_TENANT_ID },
  });
  if (!contact) return;

  // Right-to-be-forgotten: tombstone by email hash, then erase the PII.
  if (contact.email) {
    await suppress(CURRENT_TENANT_ID, contact.email, "deleted");
  }
  await prisma.contact.delete({ where: { id } });
  redirect("/contacts");
}

export default async function ContactDetail({
  params,
}: {
  params: { id: string };
}) {
  const c = await prisma.contact
    .findFirst({
      where: { id: params.id, tenantId: CURRENT_TENANT_ID },
      include: { profile: true },
    })
    .catch(() => null);

  if (!c) notFound();

  const p = c.profile;
  const raw = (c.rawFields ?? {}) as Record<string, unknown>;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">{c.name || "(no name)"}</div>
          <div className="subtle">
            {c.email} {c.phone ? `· ${c.phone}` : ""}
          </div>
        </div>
        {statusChip(c.status)}
      </div>

      <div className="card">
        <h3>Buyer profile</h3>
        {p ? (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <Row label="Budget">
              {money(p.priceMin)} – {money(p.priceMax)}
            </Row>
            <Row label="Beds / baths">
              {p.bedsMin ?? "?"}+ bd · {p.bathsMin ?? "?"}+ ba
            </Row>
            <Row label="Location">{list(p.location)}</Row>
            <Row label="Must-haves">{chips(p.mustHaves, "chip-accent")}</Row>
            <Row label="Nice to have">{chips(p.niceToHaves)}</Row>
            <Row label="Lifestyle">{chips(p.lifestyleTags)}</Row>
            <Row label="Dealbreakers">{chips(p.dealbreakers, "chip-danger")}</Row>
            {p.confidence != null && (
              <Row label="Parse confidence">
                {Math.round(p.confidence * 100)}%
              </Row>
            )}
          </div>
        ) : (
          <p className="subtle">
            Not parsed yet. Once the parser is wired up, this contact’s notes
            become a structured, matchable profile here.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Notes from CRM</h3>
        <p className="subtle" style={{ whiteSpace: "pre-wrap" }}>
          {c.sourceNotes || "—"}
        </p>
      </div>

      <div className="card">
        <h3>Lifecycle</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {(["active", "bought", "cold", "do_not_contact"] as const).map((s) => (
            <form action={setStatus} key={s}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="status" value={s} />
              <button
                className="btn btn-ghost"
                type="submit"
                disabled={c.status === s}
              >
                {label(s)}
              </button>
            </form>
          ))}
          <form action={deleteContact}>
            <input type="hidden" name="id" value={c.id} />
            <button
              className="btn btn-ghost"
              type="submit"
              style={{ color: "var(--danger)" }}
            >
              Delete (forget)
            </button>
          </form>
        </div>
        <p className="subtle" style={{ fontSize: 12.5, marginTop: 12 }}>
          “Do not contact” and “Delete” add this person to the suppression list
          so a future CRM re-import can’t bring them back.
        </p>
      </div>

      {Object.keys(raw).length > 0 && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            Raw CRM fields
          </summary>
          <pre
            className="subtle"
            style={{ overflowX: "auto", fontSize: 12.5, marginTop: 12 }}
          >
            {JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12 }}>
      <div className="subtle" style={{ fontWeight: 600 }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

const money = (n: number | null) =>
  n == null ? "?" : `$${Math.round(n / 1000)}k`;
const list = (a: string[]) => (a.length ? a.join(", ") : "—");
const label = (s: string) =>
  ({ active: "Active", bought: "Bought", cold: "Cold", do_not_contact: "Do not contact" } as Record<string, string>)[s] ?? s;

function chips(a: string[], cls = "") {
  if (!a?.length) return <span className="subtle">—</span>;
  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {a.map((x) => (
        <span key={x} className={`chip ${cls}`}>
          {x}
        </span>
      ))}
    </span>
  );
}
