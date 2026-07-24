import type { ContactStatus } from "@prisma/client";

const MAP: Record<ContactStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "chip-ok" },
  bought: { label: "Bought", cls: "chip-accent" },
  cold: { label: "Cold", cls: "chip-warn" },
  do_not_contact: { label: "Do not contact", cls: "chip-danger" },
};

export function statusChip(status: ContactStatus) {
  const s = MAP[status] ?? { label: status, cls: "" };
  return <span className={`chip ${s.cls}`}>{s.label}</span>;
}
