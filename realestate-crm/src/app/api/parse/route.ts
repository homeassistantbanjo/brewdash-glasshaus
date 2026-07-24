import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Stub: parse a contact's notes into a structured buyer profile (Phase 2).
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { error: "Profile parsing isn’t wired up yet — needs a sample CSV first (Phase 2)." },
    { status: 501 }
  );
}
