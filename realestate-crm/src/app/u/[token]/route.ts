import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { suppress } from "@/lib/suppression";

// PUBLIC, unauthenticated unsubscribe link (the recipient must be able to use
// it). It does exactly one thing — suppress — and reveals no contact data.
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const contact = await prisma.contact
    .findUnique({ where: { unsubscribeToken: params.token } })
    .catch(() => null);

  if (contact) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: "do_not_contact", statusChangedAt: new Date() },
    });
    if (contact.email) {
      await suppress(contact.tenantId, contact.email, "opt_out");
    }
  }

  // Always show the same confirmation, whether or not the token matched, so
  // the endpoint can't be used to probe who's in the system.
  return new Response(page(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function page() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:linear-gradient(135deg,#6366f1,#8b5cf6 45%,#ec4899)}
  .card{background:#fff;border-radius:20px;padding:40px;max-width:420px;
    text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.2)}
  h1{margin:0 0 8px;font-size:22px}
  p{color:#5b5f7a;margin:0}
</style></head>
<body><div class="card">
  <div style="font-size:40px">✅</div>
  <h1>You're unsubscribed</h1>
  <p>You won't receive further property emails. Thanks!</p>
</div></body></html>`;
}
