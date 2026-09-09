import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { resume } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import { getResumesDir } from '@/lib/config/paths';
import fs from 'fs';
import path from 'path';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    ensureInitialized();
    const db = getDb();
    const record = db.select().from(resume).where(eq(resume.id, 'current')).get();

    if (!record || !record.filePath) {
      return NextResponse.json(
        { success: false, error: 'No resume found.' },
        { status: 404 }
      );
    }

    const resumesDir = path.resolve(getResumesDir());
    let targetFilePath = path.resolve(record.filePath);

    if (!fs.existsSync(targetFilePath)) {
      targetFilePath = path.resolve(resumesDir, path.basename(record.filePath));
    }

    // Security check: ensure targetFilePath is strictly inside resumesDir or matches record.filePath
    const rel = path.relative(resumesDir, targetFilePath);
    const isInsideResumesDir = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!isInsideResumesDir && targetFilePath !== path.resolve(record.filePath)) {
      return NextResponse.json(
        { success: false, error: 'Access denied: invalid file path.' },
        { status: 403 }
      );
    }

    if (!fs.existsSync(targetFilePath)) {
      return NextResponse.json(
        { success: false, error: 'Resume file not found on disk.' },
        { status: 404 }
      );
    }

    const fileBuffer = fs.readFileSync(targetFilePath);
    const isDownload = request.nextUrl.searchParams.get('download') === 'true';
    const safeFilename = (record.filename || 'resume.pdf').replace(/[^\w\.\-\s]/g, '_');

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': record.mimeType || 'application/pdf',
        'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${safeFilename}"`,
        'Content-Length': fileBuffer.length.toString(),
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('Resume file route error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve resume file.' },
      { status: 500 }
    );
  }
}
