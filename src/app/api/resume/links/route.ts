import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase } from "@/db/migrate";
import { getUserVerifiedLinks, saveUserVerifiedLinks } from "@/lib/resume/profile-links";
import type { ApiResponse, VerifiedProfileLinks } from "@/types";

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<VerifiedProfileLinks>>> {
  try {
    ensureInitialized();
    const links = getUserVerifiedLinks();
    return NextResponse.json({ success: true, data: links });
  } catch (error) {
    console.error("GET verified links error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to retrieve verified profile links." },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse<ApiResponse<VerifiedProfileLinks>>> {
  try {
    ensureInitialized();
    const body = await request.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Invalid request payload." },
        { status: 400 }
      );
    }

    const updated = saveUserVerifiedLinks({
      linkedin: typeof body.linkedin === "string" ? body.linkedin : undefined,
      github: typeof body.github === "string" ? body.github : undefined,
      portfolio: typeof body.portfolio === "string" ? body.portfolio : undefined,
      other: typeof body.other === "string" ? body.other : undefined,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error("PUT verified links error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update verified profile links." },
      { status: 500 }
    );
  }
}
