import "next-auth";

declare module "next-auth" {
  interface Session {
    role?: "admin" | "agent";
    tenantId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "admin" | "agent";
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  }
}
