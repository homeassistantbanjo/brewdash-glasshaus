import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { CURRENT_TENANT_ID } from "@/lib/auth";
import { statusChip } from "@/components/status";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string };
}) {
  const q = searchParams.q?.trim();
  const status = searchParams.status;

  const contacts = await prisma.contact
    .findMany({
      where: {
        tenantId: CURRENT_TENANT_ID,
        ...(status ? { status: status as any } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { profile: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    })
    .catch(() => []);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Contacts</div>
          <div className="subtle">{contacts.length} shown</div>
        </div>
        <Link className="btn btn-primary" href="/import">
          Import CRM data
        </Link>
      </div>

      <div className="card">
        <form
          method="get"
          style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}
        >
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name or email…"
            style={inputStyle}
          />
          <select name="status" defaultValue={status ?? ""} style={inputStyle}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="bought">Bought</option>
            <option value="cold">Cold</option>
            <option value="do_not_contact">Do not contact</option>
          </select>
          <button className="btn btn-ghost" type="submit">
            Filter
          </button>
        </form>

        {contacts.length === 0 ? (
          <div className="empty">
            <span className="emoji">📇</span>
            No contacts yet. Import a CRM export to get started.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Budget</th>
                <th>Looking for</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/contacts/${c.id}`} style={{ fontWeight: 700 }}>
                      {c.name || "(no name)"}
                    </Link>
                    <div className="subtle" style={{ fontSize: 12.5 }}>
                      {c.email}
                    </div>
                  </td>
                  <td>{budget(c.profile)}</td>
                  <td className="subtle" style={{ maxWidth: 320 }}>
                    {(c.profile?.mustHaves ?? []).slice(0, 3).join(", ") ||
                      "—"}
                  </td>
                  <td>{statusChip(c.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function budget(p: { priceMin: number | null; priceMax: number | null } | null) {
  if (!p || (p.priceMin == null && p.priceMax == null)) return "—";
  const fmt = (n: number | null) =>
    n == null ? "?" : `$${Math.round(n / 1000)}k`;
  return `${fmt(p.priceMin)}–${fmt(p.priceMax)}`;
}

const inputStyle: React.CSSProperties = {
  padding: "9px 12px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  fontSize: 14,
  fontFamily: "inherit",
};
