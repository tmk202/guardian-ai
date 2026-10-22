import { NextRequest, NextResponse } from "next/server";
import { runGuardian } from "@/lib/agent";

// POST /api/chat { message: string } -> { text, steps }
// V1: single-turn per request; conversation state lives in the client.
export async function POST(req: NextRequest) {
  try {
    const { message } = (await req.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const result = await runGuardian(message);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // Most common first-run failure: missing sandbox credentials in .env.local.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
