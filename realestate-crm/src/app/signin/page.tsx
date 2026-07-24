import { signIn } from "@/lib/auth";

export default function SignInPage() {
  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <div
          className="brand"
          style={{ fontSize: 24, padding: "0 0 8px" }}
        >
          Listing Matcher
        </div>
        <p className="subtle" style={{ marginTop: 0, marginBottom: 24 }}>
          Match new listings to the right buyers and draft personal emails —
          straight into your Gmail.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/contacts" });
          }}
        >
          <button className="btn btn-primary" type="submit" style={{ width: "100%", justifyContent: "center" }}>
            Continue with Google
          </button>
        </form>
        <p className="subtle" style={{ fontSize: 12.5, marginTop: 16 }}>
          Access is limited to approved accounts.
        </p>
      </div>
    </div>
  );
}
