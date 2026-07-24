import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// Gate the whole app behind auth, except the public unsubscribe endpoint,
// the auth routes, and the sign-in page.
export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname.startsWith("/u/") || // public unsubscribe link
    pathname.startsWith("/api/auth") ||
    pathname === "/signin";

  if (isPublic) return NextResponse.next();

  if (!req.auth) {
    const url = new URL("/signin", req.nextUrl.origin);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
