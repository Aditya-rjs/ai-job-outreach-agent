import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { resume } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import { parseAndStructureResume, structureResumeText } from '@/lib/resume/resume-parser';
import type { ApiResponse, ResumeData, StructuredResumeProfile, VerifiedProfileLinks } from '@/types';
import fs from 'fs';
import path from 'path';
import { getResumesDir } from '@/lib/config/paths';
import { invalidateStaleResumeContacts } from '@/lib/scheduler/queue-manager';
import { getUserVerifiedLinks } from '@/lib/resume/profile-links';

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
      profile: StructuredResumeProfile | null;
      verifiedLinks: VerifiedProfileLinks;
    }>
  >
> {
  try {
    ensureInitialized();
    const db = getDb();
    const record = db.select().from(resume).where(eq(resume.id, 'current')).get();
    const verifiedLinks = getUserVerifiedLinks();

    if (!record) {
      return NextResponse.json({
        success: true,
        data: { resume: null, profile: null, verifiedLinks },
      });
    }

    let profile: StructuredResumeProfile | null = null;
    if (record.parsedData) {
      try {
        profile = JSON.parse(record.parsedData);
      } catch {
        // ignore parse error
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        resume: record as ResumeData,
        profile,
        verifiedLinks,
      },
    });
  } catch (error) {
    console.error('Fetch resume error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve resume information.' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ resume: ResumeData; profile: StructuredResumeProfile; verifiedLinks: VerifiedProfileLinks }>>> {
  try {
    ensureInitialized();
    const db = getDb();

    // Check if this is a JSON request to re-analyze existing stored parsedText
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      if (body.action === 'reparse') {
        const record = db.select().from(resume).where(eq(resume.id, 'current')).get();
        if (!record || !record.parsedText || record.parsedText.trim().length === 0) {
          return NextResponse.json(
            { success: false, error: 'No existing resume text found to re-analyze. Please upload a resume PDF first.' },
            { status: 400 }
          );
        }

        const profile = await structureResumeText(record.parsedText);
        const version = new Date().toISOString();

        db.update(resume)
          .set({
            parsedData: JSON.stringify(profile),
            version,
          })
          .where(eq(resume.id, 'current'))
          .run();

        const invalidatedCount = invalidateStaleResumeContacts(version);
        if (invalidatedCount > 0) {
          console.log(`[Resume Re-analyze] Invalidated ${invalidatedCount} contacts with stale resume versions.`);
        }

        const updatedRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();

        return NextResponse.json({
          success: true,
          data: {
            resume: updatedRecord as ResumeData,
            profile,
            verifiedLinks: getUserVerifiedLinks(),
          },
        });
      }
    }

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

    // Parse and structure the resume
    const { rawText, profile } = await parseAndStructureResume(buffer);

    const recordData = {
      id: 'current',
      filename,
      filePath: targetPath,
      mimeType: 'application/pdf',
      parsedText: rawText,
      parsedData: JSON.stringify(profile),
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

    // Immediately invalidate contacts generated with prior resume versions so they can be regenerated autonomously
    const invalidatedCount = invalidateStaleResumeContacts(version);
    if (invalidatedCount > 0) {
      console.log(`[Resume Upload] Invalidated ${invalidatedCount} contacts with stale resume versions for autonomous regeneration.`);
    }

    return NextResponse.json({
      success: true,
      data: {
        resume: recordData as ResumeData,
        profile,
        verifiedLinks: getUserVerifiedLinks(),
      },
    });
  } catch (error) {
    console.error('Resume upload/parse error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to parse resume document.';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
