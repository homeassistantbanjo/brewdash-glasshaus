import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Stub: extract listing features → hard-filter buyers → AI-rank survivors.
// Wired up in Phase 3 once we can design prompts against a real KW export.
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { error: "Matching isn’t wired up yet — needs a sample CSV first (Phase 3)." },
    { status: 501 }
  );
}
