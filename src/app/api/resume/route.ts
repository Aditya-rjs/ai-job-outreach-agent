import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { resume } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse, ResumeData } from '@/types';
import fs from 'fs';
import path from 'path';
import { getResumesDir } from '@/lib/config/paths';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

const MAX_RESUME_SIZE = 10 * 1024 * 1024; // 10 MB

export async function GET(): Promise<
  NextResponse<
    ApiResponse<{
      resume: ResumeData | null;
    }>
  >
> {
  try {
    ensureInitialized();
    const db = getDb();
    const record = db.select().from(resume).where(eq(resume.id, 'current')).get();

    return NextResponse.json({
      success: true,
      data: {
        resume: (record as ResumeData) || null,
      },
    });
  } catch (error) {
    console.error('Resume GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch resume file record' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ resume: ResumeData }>>> {
  try {
    ensureInitialized();
    const db = getDb();

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { success: false, error: 'No resume file provided or invalid form field.' },
        { status: 400 }
      );
    }

    const filename = file instanceof File ? file.name : 'resume.pdf';
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    if (ext !== '.pdf') {
      return NextResponse.json(
        { success: false, error: 'Only PDF resume files are currently supported.' },
        { status: 400 }
      );
    }

    if (file.size > MAX_RESUME_SIZE) {
      return NextResponse.json(
        { success: false, error: `Resume exceeds 10 MB limit (${(file.size / (1024 * 1024)).toFixed(2)} MB).` },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save copy safely in DATA_DIR/resumes/
    const resumesDir = getResumesDir();
    if (!fs.existsSync(resumesDir)) {
      fs.mkdirSync(resumesDir, { recursive: true });
    }

    const sanitizedBase = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const version = new Date().toISOString();
    const safeFilename = `${Date.now()}_${sanitizedBase}`;
    const targetPath = path.join(resumesDir, safeFilename);
    fs.writeFileSync(targetPath, buffer);

    const recordData = {
      id: 'current',
      filename,
      filePath: targetPath,
      mimeType: 'application/pdf',
      parsedText: null,
      parsedData: null,
      version,
      uploadedAt: version,
    };

    db.insert(resume)
      .values(recordData)
      .onConflictDoUpdate({
        target: resume.id,
        set: recordData,
      })
      .run();

    return NextResponse.json({
      success: true,
      data: {
        resume: recordData as ResumeData,
      },
    });
  } catch (error) {
    console.error('Resume upload error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to upload resume document.';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
