import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getCandidateProfile, saveCandidateProfile } from '@/lib/candidate-profile/candidate-profile-service';
import type { ApiResponse, CandidateProfile } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<CandidateProfile>>> {
  try {
    ensureInitialized();
    const profile = getCandidateProfile();
    return NextResponse.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error('GET /api/candidate-profile error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch candidate profile',
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse<ApiResponse<CandidateProfile>>> {
  try {
    ensureInitialized();
    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload. JSON object expected.' },
        { status: 400 }
      );
    }

    const updated = saveCandidateProfile(body);

    return NextResponse.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error('PUT /api/candidate-profile error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update candidate profile',
      },
      { status: 500 }
    );
  }
}
