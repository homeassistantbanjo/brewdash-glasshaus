import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  const role = (session as any)?.role ?? "agent";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Listing Matcher</div>
        <Link className="nav-link" href="/contacts">
          👥 Contacts
        </Link>
        <Link className="nav-link" href="/import">
          ⬆️ Import CRM
        </Link>
        <Link className="nav-link" href="/match">
          ✨ Match a listing
        </Link>

        <div style={{ marginTop: "auto", paddingTop: 24 }}>
          <div className="subtle" style={{ fontSize: 12.5, marginBottom: 8 }}>
            {email}
            {role === "admin" ? " · admin" : ""}
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button className="btn btn-ghost" type="submit" style={{ width: "100%", justifyContent: "center" }}>
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
