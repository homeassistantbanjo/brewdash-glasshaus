import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// The only accounts allowed to sign in (Jordan + mom). Swap this callback for
// self-serve signup when/if this becomes multi-tenant — see ../PLAN.md.
const allowlist = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();

// For the single-tenant phase, everyone shares one tenant. Later this becomes
// a per-account/org id.
export const CURRENT_TENANT_ID = "default";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          // gmail.compose = create drafts, CANNOT send. Least privilege.
          scope:
            "openid email profile https://www.googleapis.com/auth/gmail.compose",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  pages: { signIn: "/signin" },
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      return !!email && allowlist.includes(email);
    },
    async jwt({ token, account }) {
      // TODO(security): persist Gmail tokens encrypted-at-rest in the DB rather
      // than in the JWT before this handles real client PII in production.
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
      }
      const email = (token.email as string | undefined)?.toLowerCase();
      token.role = email && email === adminEmail ? "admin" : "agent";
      return token;
    },
    async session({ session, token }) {
      (session as any).role = token.role;
      (session as any).tenantId = CURRENT_TENANT_ID;
      return session;
    },
  },
});
