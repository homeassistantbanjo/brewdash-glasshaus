import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Stub: draft a personal email per selected buyer and create it in the agent's
// Gmail Drafts (gmail.compose). Wired up in Phase 4.
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { error: "Drafting isn’t wired up yet (Phase 4)." },
    { status: 501 }
  );
}
